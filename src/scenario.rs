//! Per-scenario coverage and evidence for interaction-only execution.
use std::collections::BTreeMap;

use anyhow::Result;
use serde::Serialize;

use crate::{
    Counts, PackageRow, SourceRow, Span, Status,
    attribution::{self, IndexedSegment, IndexedSource},
    coverage::Interval,
    text::TextIndex,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstObserved {
    pub scenario: String,
    pub bytes: usize,
    /// An earlier scenario lacked a recording for this bundle.
    pub earlier_unmeasured: bool,
}

pub(crate) fn first_observed(
    order: &[String],
    segments: &[IndexedSegment],
    source_count: usize,
    used: &BTreeMap<String, Vec<Interval>>,
) -> Vec<Vec<FirstObserved>> {
    let mut result = vec![Vec::new(); source_count];
    let mut earlier = Vec::new();
    let mut missing = false;
    for name in order {
        let Some(current) = used.get(name) else {
            missing = true;
            continue;
        };
        let first = difference(current, &earlier);
        let mut cursor = 0;
        let mut counts = vec![0; source_count];
        for segment in segments {
            counts[segment.source] += overlap(segment, &first, &mut cursor);
        }
        for (id, bytes) in counts
            .into_iter()
            .enumerate()
            .filter(|(_, bytes)| *bytes > 0)
        {
            result[id].push(FirstObserved {
                scenario: name.clone(),
                bytes,
                earlier_unmeasured: missing,
            });
        }
        earlier.extend_from_slice(current);
        earlier = crate::coverage::union(earlier);
    }
    result
}

pub(crate) fn spans(
    segments: &[IndexedSegment],
    used: Option<&[Interval]>,
    indices: &[Option<usize>],
    text: &TextIndex,
) -> Result<Vec<Span>> {
    let mut spans = Vec::new();
    let mut index = 0;
    for segment in segments {
        let mut append = |start, end, status| -> Result<()> {
            if start < end {
                spans.push(Span {
                    start,
                    end,
                    start_utf16: text.utf16(start)?,
                    end_utf16: text.utf16(end)?,
                    source: indices[segment.source].unwrap(),
                    status,
                    original: segment.original,
                });
            }
            Ok(())
        };
        let Some(used) = used else {
            append(segment.start, segment.end, Status::Unmeasured)?;
            continue;
        };
        while index < used.len() && used[index].end <= segment.start {
            index += 1;
        }
        let mut cursor = segment.start;
        for range in used[index..]
            .iter()
            .take_while(|range| range.start < segment.end)
        {
            let start = range.start.max(segment.start);
            let end = range.end.min(segment.end);
            append(cursor, start, Status::Unobserved)?;
            append(start, end, Status::Observed)?;
            cursor = end;
        }
        append(cursor, segment.end, Status::Unobserved)?;
    }
    Ok(spans)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioReport {
    pub scenario: String,
    pub totals: Counts,
    pub bundles: Vec<ScenarioBundle>,
    pub sources: Vec<SourceRow>,
    pub packages: Vec<PackageRow>,
    /// Sources with bytes executed here but not observed in the initial scenario.
    /// Missing initial recordings are reported separately, never treated as zero use.
    pub interaction_candidates: Vec<InteractionCandidate>,
}

#[derive(Debug, Serialize)]
pub struct ScenarioBundle {
    pub path: String,
    pub sources: Vec<SourceRow>,
    #[serde(flatten)]
    pub counts: Counts,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionCandidate {
    pub source: String,
    pub package: String,
    pub interaction_only_bytes: usize,
    pub initial_unmeasured_observed_bytes: usize,
    pub estimated_deferrable_compression: Option<crate::ci::CompressedSizes>,
}

pub(crate) struct Accumulator {
    pub report: ScenarioReport,
    sources: BTreeMap<String, Counts>,
    candidates: BTreeMap<String, InteractionCandidate>,
}

impl Accumulator {
    pub fn new(scenario: String) -> Self {
        Self {
            report: ScenarioReport {
                scenario,
                totals: Counts::default(),
                bundles: Vec::new(),
                sources: Vec::new(),
                packages: Vec::new(),
                interaction_candidates: Vec::new(),
            },
            sources: BTreeMap::new(),
            candidates: BTreeMap::new(),
        }
    }

    pub fn bundle(
        &mut self,
        path: &str,
        segments: &[IndexedSegment],
        sources: &[IndexedSource],
        used: &BTreeMap<String, Vec<Interval>>,
        initial: Option<&str>,
        content: Option<&[u8]>,
    ) -> Result<()> {
        let observed = used.get(&self.report.scenario);
        let mut cursor = 0;
        let mut extra_cursor = 0;
        let initial_used = initial.and_then(|name| used.get(name));
        let compare = initial.is_some_and(|name| name != self.report.scenario);
        let extra = if compare {
            difference(
                observed.map_or(&[], Vec::as_slice),
                initial_used.map_or(&[], Vec::as_slice),
            )
        } else {
            Vec::new()
        };
        let mut total = Counts::default();
        let mut bundle_sources: BTreeMap<String, Counts> = BTreeMap::new();
        let mut fragments: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        for segment in segments {
            let bytes = segment.end - segment.start;
            let observed_bytes = overlap(segment, observed.map_or(&[], Vec::as_slice), &mut cursor);
            let counts = Counts {
                bytes,
                observed_bytes,
                unobserved_bytes: if observed.is_some() {
                    bytes - observed_bytes
                } else {
                    0
                },
                unmeasured_bytes: if observed.is_none() { bytes } else { 0 },
            };
            let source = &sources[segment.source].name;
            total.add(&counts);
            self.sources.entry(source.clone()).or_default().add(&counts);
            bundle_sources
                .entry(source.clone())
                .or_default()
                .add(&counts);
            let extra_bytes = overlap(segment, &extra, &mut extra_cursor);
            if extra_bytes > 0 {
                let candidate =
                    self.candidates
                        .entry(source.clone())
                        .or_insert_with(|| InteractionCandidate {
                            source: source.clone(),
                            package: attribution::package(source),
                            ..Default::default()
                        });
                if initial_used.is_some() {
                    candidate.interaction_only_bytes += extra_bytes;
                    if let Some(content) = content {
                        let bytes = fragments.entry(source.clone()).or_default();
                        for range in extra[extra_cursor..]
                            .iter()
                            .take_while(|range| range.start < segment.end)
                        {
                            bytes.extend_from_slice(
                                &content
                                    [range.start.max(segment.start)..range.end.min(segment.end)],
                            );
                        }
                    }
                } else {
                    candidate.initial_unmeasured_observed_bytes += extra_bytes;
                }
            }
        }
        self.report.totals.add(&total);
        self.report.bundles.push(ScenarioBundle {
            path: path.into(),
            sources: crate::aggregate_sources(bundle_sources).0,
            counts: total,
        });
        for (source, bytes) in fragments {
            self.candidates
                .get_mut(&source)
                .unwrap()
                .estimated_deferrable_compression
                .get_or_insert_default()
                .add(&crate::ci::compress(&bytes)?);
        }
        Ok(())
    }

    pub fn finish(mut self) -> ScenarioReport {
        (self.report.sources, self.report.packages) = crate::aggregate_sources(self.sources);
        self.report.interaction_candidates = self.candidates.into_values().collect();
        self.report.interaction_candidates.sort_by(|a, b| {
            b.interaction_only_bytes
                .cmp(&a.interaction_only_bytes)
                .then(
                    b.initial_unmeasured_observed_bytes
                        .cmp(&a.initial_unmeasured_observed_bytes),
                )
                .then(a.source.cmp(&b.source))
        });
        self.report
    }
}

pub(crate) fn overlap(segment: &IndexedSegment, used: &[Interval], cursor: &mut usize) -> usize {
    while *cursor < used.len() && used[*cursor].end <= segment.start {
        *cursor += 1;
    }
    used[*cursor..]
        .iter()
        .take_while(|range| range.start < segment.end)
        .map(|range| {
            range
                .end
                .min(segment.end)
                .saturating_sub(range.start.max(segment.start))
        })
        .sum()
}

/// Set subtraction on sorted, disjoint byte ranges (not subtraction of totals).
pub(crate) fn difference(used: &[Interval], initial: &[Interval]) -> Vec<Interval> {
    let mut result = Vec::new();
    let mut index = 0;
    for range in used {
        let mut cursor = range.start;
        while index < initial.len() && initial[index].end <= cursor {
            index += 1;
        }
        for earlier in initial[index..]
            .iter()
            .take_while(|other| other.start < range.end)
        {
            if cursor < earlier.start {
                result.push(Interval {
                    start: cursor,
                    end: earlier.start.min(range.end),
                });
            }
            cursor = cursor.max(earlier.end);
        }
        if cursor < range.end {
            result.push(Interval {
                start: cursor,
                end: range.end,
            });
        }
    }
    result
}
