//! Review suggestions grounded in measured scenarios and explicit import evidence.
use crate::{
    Report,
    attribution::UNMAPPED,
    ci::CompressedSizes,
    graph::{ImportKind, ImportStep},
    metadata::ImportPath,
};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub kind: &'static str,
    pub source: String,
    pub scenario: Option<String>,
    pub bytes: usize,
    pub estimated_compression: Option<CompressedSizes>,
    pub import_path: Option<ImportPath>,
    /// Bytes of this source observed in the initial scenario.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_observed_bytes: Option<usize>,
    /// Whether those initial bytes ran only as module evaluation: at the script's top level or
    /// in bundler wrappers that map to no source, not inside a mapped function.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_top_level_only: Option<bool>,
    pub explanation: &'static str,
}

pub fn build(report: &Report) -> Vec<Recommendation> {
    let mut result = Vec::new();
    let initial = report
        .scenario_reports
        .iter()
        .find(|s| Some(&s.scenario) == report.initial_scenario.as_ref());
    for scenario in &report.scenario_reports {
        for candidate in &scenario.interaction_candidates {
            if candidate.source == UNMAPPED {
                continue;
            }
            let path = report.import_paths.as_ref().and_then(|paths| {
                paths
                    .iter()
                    .find(|p| p.resolved_source.as_ref() == Some(&candidate.source))
            });
            let initial_counts = initial
                .and_then(|s| s.sources.iter().find(|s| s.source == candidate.source))
                .map(|s| &s.counts);
            let synchronous_chain = path.is_some_and(|p| {
                !p.edges.is_empty() && p.edges.iter().all(ImportStep::synchronous)
            });
            let dynamic_chain =
                path.is_some_and(|p| p.edges.iter().any(|e| e.kind == ImportKind::Dynamic));
            let initial_observed = initial_counts
                .map(|c| c.observed_bytes)
                .filter(|bytes| *bytes > 0);
            let execution = report.initial_execution.get(&candidate.source);
            let top_level_only =
                initial_observed.map(|_| execution.is_some_and(|e| e.function_bytes == 0));
            let top_level_effect = execution.is_some_and(|e| has_top_level_effect(&e.top_level));
            let (kind, explanation) = if candidate.initial_unmeasured_observed_bytes > 0
                || initial_counts.is_none_or(|c| c.unmeasured_bytes > 0)
            {
                (
                    "measure-initial",
                    "Record this source in the initial scenario before inferring deferrable bytes. Missing coverage does not prove the chunk was absent from the initial load.",
                )
            } else if synchronous_chain && top_level_only == Some(false) {
                (
                    "split-review",
                    "A synchronous import chain (static imports or top-level require() calls) reaches this source, and part of it executes initially. Consider separating the later-only functionality before introducing import(); deferring the whole module may break initial behavior.",
                )
            } else if synchronous_chain && top_level_effect {
                (
                    "split-review",
                    "A synchronous import chain (static imports or top-level require() calls) reaches this source. Initially only its top-level code ran, but that code calls, constructs or writes properties, which initial behavior may depend on. Check those statements before moving the import behind this interaction.",
                )
            } else if synchronous_chain && top_level_only == Some(true) {
                (
                    "defer-review",
                    "A synchronous import chain (static imports or top-level require() calls) reaches this source. Initially only its top-level declarations were evaluated, with no calls, constructions or property writes other than CommonJS exports; its functions execute in this interaction. Review moving the import behind this interaction and rebuild to measure transfer savings.",
                )
            } else if synchronous_chain {
                (
                    "defer-review",
                    "A synchronous import chain (static imports or top-level require() calls) reaches this source. It was measured but not observed initially and executes in this interaction. Review moving the import behind this interaction, checking side effects and rebuilding to measure transfer savings.",
                )
            } else if dynamic_chain {
                (
                    "dynamic-boundary-review",
                    "The recorded graph path already crosses import(). Check when that boundary is invoked or prefetched before adding another split; this path does not establish all routes to the module.",
                )
            } else {
                (
                    "inspect-imports",
                    "These measured bytes execute in this interaction but not initially. Inspect the import graph and side effects before choosing a lazy-loading boundary.",
                )
            };
            result.push(Recommendation {
                kind,
                source: candidate.source.clone(),
                scenario: Some(scenario.scenario.clone()),
                bytes: candidate.interaction_only_bytes
                    + candidate.initial_unmeasured_observed_bytes,
                estimated_compression: if kind == "measure-initial" {
                    None
                } else {
                    candidate.estimated_deferrable_compression.clone()
                },
                import_path: path.cloned(),
                initial_observed_bytes: initial_observed,
                initial_top_level_only: top_level_only,
                explanation,
            });
        }
    }
    for source in &report.sources {
        if source.source == UNMAPPED
            || source.counts.observed_bytes > 0
            || report.scenario_reports.is_empty()
        {
            continue;
        }
        let fully_measured = report.scenario_reports.iter().all(|scenario| {
            scenario
                .sources
                .iter()
                .any(|s| s.source == source.source && s.counts.unmeasured_bytes == 0)
        });
        if fully_measured {
            result.push(Recommendation { kind: "removal-review", source: source.source.clone(), scenario: None,
                bytes: source.counts.bytes, estimated_compression: source.estimated_compression.clone(), import_path: None,
                initial_observed_bytes: None, initial_top_level_only: None,
                explanation: "No execution was observed in any supplied scenario, and each scenario measured this source. Review missing user flows, side effects and tests before removing it; coverage alone does not prove removal is safe." });
        }
    }
    result.sort_by(|a, b| {
        b.bytes
            .cmp(&a.bytes)
            .then(a.source.cmp(&b.source))
            .then(a.scenario.cmp(&b.scenario))
    });
    result
}

/// Conservative scan of generated top-level code: any call, construction, tagged template,
/// class, member write, update or `delete`/`await` counts, even inside string literals.
/// Plain CommonJS export writes (`X.exports = `, `X.exports.a = `, `exports.a = `) only build the
/// module's own exports and do not count. Property reads that trigger getters are not detected.
fn has_top_level_effect(code: &[u8]) -> bool {
    let identifier = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80;
    let mut words = code.split(|b| !identifier(*b));
    if code.contains(&b'(')
        || code.windows(2).any(|w| w == b"++" || w == b"--")
        || words.any(|w| matches!(w, b"new" | b"class" | b"delete" | b"await"))
    {
        return true;
    }
    code.iter().enumerate().any(|(i, &b)| {
        let before = code[..i].trim_ascii_end();
        match b {
            b'`' if code[..i].iter().filter(|&&p| p == b'`').count() % 2 == 0 => before
                .last()
                .is_some_and(|&p| identifier(p) || p == b')' || p == b']'),
            b'=' if !matches!(code.get(i + 1), Some(b'=' | b'>'))
                && !matches!(before.last(), Some(b'=' | b'!' | b'<' | b'>')) =>
            {
                let target = before.trim_ascii_end();
                let compound = target
                    .iter()
                    .rev()
                    .take_while(|p| b"+-*/%&|^<>?".contains(p))
                    .count();
                let target = &target[..target.len() - compound];
                let name = target.iter().rev().take_while(|p| identifier(**p)).count();
                let path = target.len()
                    - target
                        .iter()
                        .rev()
                        .take_while(|p| identifier(**p) || **p == b'.')
                        .count();
                let parts: Vec<&[u8]> = target[path..].split(|p| *p == b'.').collect();
                let export = compound == 0
                    && match parts[..] {
                        [object, b"exports", ..] => !object.is_empty() && parts.len() <= 3,
                        [b"exports", _] => true,
                        _ => false,
                    };
                !export
                    && (matches!(target.last(), Some(b']'))
                        || target[..target.len() - name].trim_ascii_end().last() == Some(&b'.'))
            }
            _ => false,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::has_top_level_effect;

    #[test]
    fn top_level_effects() {
        for code in [
            "m=480,h=200;",
            "var b=`modulepreload`,ee=",
            "const a={x:1,y:[2]},b=a.x,c=a==b,d=a<=b;",
            "t.exports={compute:}}",
            "module.exports = {};",
            "exports.a=b;",
            "t.exports.a=1;",
        ] {
            assert!(!has_top_level_effect(code.as_bytes()), "{code}");
        }
        for code in [
            "customElements.define(`x-a`,A);",
            "window.onload=f;",
            "a[0]=1;",
            "o.n+=1;",
            "x=new Map;",
            "t=css`a`;",
            "class A{static x=1}",
            "n++;",
            "delete o.a;",
            "t.exports=e.r(1);",
            "a.b.exports=1;",
            "t.exports.a.b=1;",
            "t.exports+=1;",
            "a[0].exports=1;",
        ] {
            assert!(has_top_level_effect(code.as_bytes()), "{code}");
        }
    }
}
