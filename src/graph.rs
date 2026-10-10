//! Import evidence exported from real bundler graphs, with explicit location provenance.
use crate::{Report, metadata::ImportPath, source_path::SourcePaths};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportKind {
    Static,
    Dynamic,
    Require,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Location {
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStep {
    pub from: String,
    pub to: String,
    pub kind: ImportKind,
    pub location: Option<Location>,
    pub location_evidence: Option<String>,
    pub specifier: Option<String>,
    /// For a `require` edge parsed from source: whether the call runs whenever the importer evaluates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_level: Option<bool>,
}

impl ImportStep {
    /// Static imports and top-level require() calls evaluate the target while the importer evaluates.
    pub fn synchronous(&self) -> bool {
        self.kind == ImportKind::Static
            || (self.kind == ImportKind::Require && self.top_level == Some(true))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Module {
    id: String,
    source: String,
    #[serde(default)]
    entry: bool,
    emitted_bytes: Option<usize>,
    source_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Graph {
    schema_version: u32,
    bundler: String,
    modules: Vec<Module>,
    edges: Vec<ImportStep>,
    #[serde(default)]
    warnings: Vec<String>,
}

const ROOT_HINT: &str = "the directory the graph's source paths are relative to: webpack's context, turbopack.root, or coldpath graph --root";

/// The root recorded in a graph, resolved against the graph file's directory. An invalid
/// graph has none here; [`attach`] reports it.
pub fn recorded_root(data: &[u8], graph_file: &Path) -> Option<PathBuf> {
    #[derive(Deserialize)]
    struct Recorded {
        root: Option<String>,
    }
    let root = serde_json::from_slice::<Recorded>(data).ok()?.root?;
    Some(graph_file.parent().unwrap_or(Path::new("")).join(root))
}

/// Directories a misplaced graph root may have meant: the analysis root, the current
/// directory, and their ancestors, nearest first.
fn root_candidates(root: &Path) -> Vec<PathBuf> {
    let cwd = std::env::current_dir().and_then(std::fs::canonicalize).ok();
    let mut candidates: Vec<PathBuf> = Vec::new();
    for start in [Some(root.to_path_buf()), cwd].into_iter().flatten() {
        for directory in start.ancestors() {
            if !candidates.iter().any(|c| c == directory) {
                candidates.push(directory.into());
            }
        }
    }
    candidates
}

/// Report source names by the physical path they identify.
fn source_aliases(
    report: &Report,
    resolver: &SourcePaths,
    report_resolver: &SourcePaths,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut aliases: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in &report.sources {
        let physical = if let Some(rest) = row.source.strip_prefix("webpack://") {
            rest.split_once('/')
                .map(|(_, path)| resolver.resolve(path.trim_start_matches('/')))
        } else if let Some(rest) = row.source.strip_prefix("turbopack:///") {
            rest.strip_prefix("[project]/")
                .map(|path| resolver.resolve(path))
        } else {
            Some(report_resolver.resolve(&row.source))
        };
        if let Some(physical) = physical {
            aliases
                .entry(physical)
                .or_default()
                .insert(row.source.clone());
        }
    }
    aliases
}

pub fn attach(
    report: &mut Report,
    data: &[u8],
    analysis_root: &Path,
    build_root: &Path,
) -> Result<()> {
    let graph: Graph = serde_json::from_slice(data).context(
        "invalid graph; export with coldpath graph or the coldpath/rollup, coldpath/vite, or coldpath/webpack plugins",
    )?;
    ensure!(
        graph.schema_version == 1,
        "unsupported graph schema version"
    );
    ensure!(!graph.modules.is_empty(), "graph has no modules");
    let modules = graph
        .modules
        .iter()
        .map(|m| (m.id.as_str(), m))
        .collect::<BTreeMap<_, _>>();
    ensure!(
        modules.len() == graph.modules.len(),
        "graph has duplicate module IDs"
    );
    let mut outgoing: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (index, edge) in graph.edges.iter().enumerate() {
        ensure!(
            modules.contains_key(edge.from.as_str()) && modules.contains_key(edge.to.as_str()),
            "graph edge references unknown module"
        );
        if let Some(location) = &edge.location {
            ensure!(
                location.line > 0 && location.column > 0,
                "graph locations must be one-based"
            );
        }
        outgoing.entry(edge.from.as_str()).or_default().push(index);
    }
    let roots = graph
        .modules
        .iter()
        .filter(|m| m.entry)
        .map(|m| m.id.as_str())
        .collect::<Vec<_>>();
    ensure!(!roots.is_empty(), "graph has no entry modules");
    // Prefer a proven synchronous chain over a shorter path crossing a dynamic boundary.
    let walk = |synchronous_only: bool| {
        let mut paths: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        let mut queue = VecDeque::new();
        for root in &roots {
            paths.insert(*root, Vec::new());
            queue.push_back(*root);
        }
        while let Some(from) = queue.pop_front() {
            for &index in outgoing.get(from).into_iter().flatten() {
                let edge = &graph.edges[index];
                if synchronous_only && !edge.synchronous() {
                    continue;
                }
                if !paths.contains_key(edge.to.as_str()) {
                    let mut path = paths[from].clone();
                    path.push(index);
                    paths.insert(&edge.to, path);
                    queue.push_back(&edge.to);
                }
            }
        }
        paths
    };
    let synchronous_paths = walk(true);
    let all_paths = walk(false);
    let root = std::fs::canonicalize(analysis_root)?;
    let directory = std::fs::canonicalize(build_root)?;
    let resolver = SourcePaths {
        root: &root,
        directory: &directory,
    };
    let report_resolver = SourcePaths {
        root: &root,
        directory: &root,
    };
    let aliases = source_aliases(report, &resolver, &report_resolver);
    let contents = report
        .bundles
        .iter()
        .flat_map(|b| &b.sources)
        .filter_map(|s| s.content.as_ref().map(|c| (&s.source, c)))
        .collect::<Vec<_>>();
    let mut verified = BTreeSet::new();
    let (mut unchecked, mut on_disk_only) = (0, 0);
    for module in &graph.modules {
        let Some(expected) = &module.source_sha256 else {
            continue;
        };
        let matching = aliases
            .get(&resolver.resolve(&module.source))
            .into_iter()
            .flat_map(|names| {
                contents
                    .iter()
                    .filter(move |(name, _)| names.contains(*name))
            })
            .collect::<Vec<_>>();
        if matching.is_empty() {
            unchecked += 1;
            continue;
        }
        if matching
            .iter()
            .all(|(_, content)| crate::sha256(content.as_bytes()) == *expected)
        {
            verified.insert(module.id.as_str());
            continue;
        }
        // Loaders such as Babel replace sourcesContent with their own output. The graph
        // still describes these sources when it matches the file on disk; its locations
        // stay unverified against the maps. A file missing from the graph root points at
        // the root rather than the graph.
        let file = directory.join(&module.source);
        match std::fs::read(&file) {
            Ok(bytes) => ensure!(
                crate::sha256(&bytes) == *expected,
                "graph source snapshot differs from sourcesContent for {}; regenerate the graph from this build's sources",
                module.source
            ),
            Err(_) => {
                let candidate = root_candidates(&root).into_iter().find(|candidate| {
                    *candidate != directory
                        && std::fs::read(candidate.join(&module.source))
                            .is_ok_and(|bytes| crate::sha256(&bytes) == *expected)
                });
                anyhow::bail!(
                    "graph source snapshot differs from sourcesContent for {}, and the file is not under the graph root {}. {}",
                    module.source,
                    directory.display(),
                    match candidate {
                        Some(candidate) => format!(
                            "{} holds it with the graph's snapshot, so the graph root looks wrong: pass --graph-root {}.",
                            candidate.display(),
                            candidate.display()
                        ),
                        None => format!(
                            "Check --graph-root ({ROOT_HINT}) or regenerate the graph from this build's sources."
                        ),
                    }
                );
            }
        }
        report.read_files.push(file);
        on_disk_only += 1;
    }
    let mut paths = Vec::new();
    for module in &graph.modules {
        let Some(names) = aliases.get(&resolver.resolve(&module.source)) else {
            continue;
        };
        let path = synchronous_paths
            .get(module.id.as_str())
            .or_else(|| all_paths.get(module.id.as_str()));
        let edges = path
            .into_iter()
            .flatten()
            .map(|&index| {
                let mut step = graph.edges[index].clone();
                if step.location.is_some() && verified.contains(step.from.as_str()) {
                    step.location_evidence = Some(format!(
                        "{}+sources-content-sha256",
                        step.location_evidence.as_deref().unwrap_or("graph")
                    ));
                }
                step.from = modules[step.from.as_str()].source.clone();
                step.to = modules[step.to.as_str()].source.clone();
                step
            })
            .collect::<Vec<_>>();
        let chain = path.map(|_| {
            let mut chain = edges
                .iter()
                .map(|step| step.from.clone())
                .collect::<Vec<_>>();
            chain.push(module.source.clone());
            chain
        });
        for name in names {
            paths.push(ImportPath {
                source: module.source.clone(),
                resolved_source: Some(name.clone()),
                bytes_in_output: module.emitted_bytes.unwrap_or(0),
                path: chain.clone(),
                graph_format: graph.bundler.clone(),
                edges: edges.clone(),
            });
        }
    }
    paths.sort_by(|a, b| {
        a.resolved_source
            .cmp(&b.resolved_source)
            .then_with(|| {
                let rank = |p: &ImportPath| {
                    if p.path.is_none() {
                        3
                    } else if !p.edges.is_empty() && p.edges.iter().all(ImportStep::synchronous) {
                        0
                    } else if p.edges.iter().any(|e| e.kind == ImportKind::Dynamic) {
                        1
                    } else {
                        2
                    }
                };
                rank(a).cmp(&rank(b))
            })
            .then(a.edges.len().cmp(&b.edges.len()))
    });
    report.warnings.extend(graph.warnings);
    let on_disk_note = if on_disk_only > 0 {
        format!(
            " {on_disk_only} matched only the file on disk because sourcesContent was transformed (for example by Babel); their import locations are unverified;"
        )
    } else {
        String::new()
    };
    report.warnings.push(format!("Graph source snapshots: {} matched sourcesContent;{on_disk_note} {unchecked} could not be checked. Graph topology itself is not capture-hash verified; retain the graph from the same build.", verified.len()));
    if paths.is_empty() {
        // Only identities resolved through the graph root can change with it.
        let candidate = root_candidates(&root)
            .into_iter()
            .filter(|candidate| *candidate != directory)
            .map(|candidate| {
                let resolver = SourcePaths {
                    root: &root,
                    directory: &candidate,
                };
                let aliases = source_aliases(report, &resolver, &report_resolver);
                let matched = graph
                    .modules
                    .iter()
                    .filter(|m| aliases.contains_key(&resolver.resolve(&m.source)))
                    .count();
                (matched, candidate)
            })
            .filter(|(matched, _)| *matched > 0)
            .max_by_key(|(matched, _)| *matched);
        report.warnings.push(match candidate {
            Some((matched, candidate)) => format!(
                "No graph modules matched source-map identities under the graph root {}, but {matched} match under {}: pass --graph-root {}.",
                directory.display(),
                candidate.display(),
                candidate.display()
            ),
            None => format!(
                "No graph modules matched source-map identities; check --graph-root ({ROOT_HINT}) and the selected build."
            ),
        });
    }
    report.import_paths = Some(paths);
    report.recommendations = crate::recommendations::build(report);
    Ok(())
}
