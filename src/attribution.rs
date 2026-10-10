use anyhow::{Result, bail, ensure};
use serde::Serialize;
use sourcemap::DecodedMap;
use std::collections::BTreeMap;

use crate::text::TextIndex;

pub const UNMAPPED: &str = "[unmapped]";

#[derive(Debug)]
pub struct Segment {
    pub start: usize,
    pub end: usize,
    pub source: String,
    pub original: Option<OriginalPosition>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct OriginalPosition {
    pub line: u32,
    pub column: u32,
}

pub struct Attribution {
    pub segments: Vec<Segment>,
    pub invalid_points: usize,
    pub contents: BTreeMap<String, String>,
}

pub(crate) struct IndexedSegment {
    pub start: usize,
    pub end: usize,
    pub source: usize,
    pub original: Option<OriginalPosition>,
}

pub(crate) struct IndexedSource {
    pub name: String,
    pub content: Option<String>,
}

pub(crate) struct IndexedAttribution {
    pub segments: Vec<IndexedSegment>,
    pub sources: Vec<IndexedSource>,
    pub rejected: Vec<Rejection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RejectionReason {
    ColumnOutsideLine,
    InsideSurrogatePair,
}

/// A decoded mapping at an absolute generated position (index-map offsets applied).
#[derive(Clone, Copy)]
pub(crate) struct Mapping {
    pub generated: Position,
    pub source: usize,
    pub original: Option<OriginalPosition>,
}

/// A mapping that could not be placed. The region spans the same-line neighbors
/// (or line edges): its bytes may belong elsewhere, but no byte error is proven.
pub(crate) struct Rejection {
    pub reason: RejectionReason,
    pub mapping: Mapping,
    pub previous: Option<Mapping>,
    pub next: Option<Mapping>,
    pub start: usize,
    pub end: usize,
}

/// Attribute each mapping to the next mapping on the SAME line or line end.
/// Prefixes, newlines, mapping gaps and bundler wrappers remain explicitly unmapped.
pub fn segments(data: &[u8], text: &TextIndex, byte_len: usize) -> Result<Vec<Segment>> {
    Ok(segments_with_diagnostics(data, text, byte_len)?.0)
}

pub fn segments_with_diagnostics(
    data: &[u8],
    text: &TextIndex,
    byte_len: usize,
) -> Result<(Vec<Segment>, usize)> {
    let result = decode(data, text, byte_len)?;
    Ok((result.segments, result.invalid_points))
}

pub fn decode(data: &[u8], text: &TextIndex, byte_len: usize) -> Result<Attribution> {
    decode_with_contents(data, text, byte_len, true)
}

pub fn decode_with_contents(
    data: &[u8],
    text: &TextIndex,
    byte_len: usize,
    retain_contents: bool,
) -> Result<Attribution> {
    let decoded = decode_indexed(data, text, byte_len, retain_contents, None)?;
    Ok(Attribution {
        segments: decoded
            .segments
            .into_iter()
            .map(|s| Segment {
                start: s.start,
                end: s.end,
                source: decoded.sources[s.source].name.clone(),
                original: s.original,
            })
            .collect(),
        invalid_points: decoded.rejected.len(),
        contents: decoded
            .sources
            .into_iter()
            .filter_map(|s| s.content.map(|content| (s.name, content)))
            .collect(),
    })
}

pub(crate) fn decode_indexed(
    data: &[u8],
    text: &TextIndex,
    byte_len: usize,
    retain_contents: bool,
    source_paths: Option<&crate::source_path::SourcePaths<'_>>,
) -> Result<IndexedAttribution> {
    validate_map(&serde_json::from_slice(data)?)?;
    let map = sourcemap::decode_slice(data)?;
    let mut decoder = Decoder {
        text,
        retain_contents,
        source_paths,
        points: Vec::new(),
        sources: vec![IndexedSource {
            name: UNMAPPED.into(),
            content: None,
        }],
        source_ids: BTreeMap::from([(UNMAPPED.to_owned(), 0)]),
        rejected: Vec::new(),
    };
    decoder.collect(&map, (0, 0), None)?;
    // Stable ordering preserves last-mapping-wins at duplicate positions,
    // including explicit boundaries of empty/nested index-map sections.
    if !decoder.points.is_sorted_by_key(|p| p.position) {
        decoder.points.sort_by_key(|p| p.position);
    }
    let effective = |p: &Point| Mapping {
        generated: p.position,
        source: p.source,
        original: p.original,
    };
    let mut rejected = Vec::with_capacity(decoder.rejected.len());
    for (reason, mapping) in decoder.rejected {
        let line = mapping.generated.0;
        let points = &decoder.points;
        let split = points.partition_point(|p| p.position < mapping.generated);
        // Duplicate positions keep the last mapping, as attribution does.
        let previous = split
            .checked_sub(1)
            .map(|i| &points[i])
            .filter(|p| p.position.0 == line);
        let next = points
            .get(split)
            .filter(|p| p.position.0 == line)
            .map(|first| {
                &points
                    [split + points[split..].partition_point(|p| p.position == first.position) - 1]
            });
        rejected.push(Rejection {
            reason,
            mapping,
            start: previous.map_or_else(|| text.position(line, 0), |p| Ok(p.byte))?,
            end: next.map_or_else(|| text.line_end(line), |p| Ok(p.byte))?,
            previous: previous.map(effective),
            next: next.map(effective),
        });
    }
    let mut points = decoder.points.into_iter().peekable();
    let mut result = Vec::with_capacity(points.len() + 1);
    let mut cursor = 0;
    while let Some(mut point) = points.next() {
        while points
            .peek()
            .is_some_and(|next| next.position == point.position)
        {
            point = points.next().unwrap();
        }
        let start = point.byte;
        ensure!(start >= cursor, "overlapping source-map segments");
        if start > cursor {
            result.push(IndexedSegment {
                start: cursor,
                end: start,
                source: 0,
                original: None,
            });
        }
        let end = match points.peek() {
            Some(next) if next.position.0 == point.position.0 => next.byte,
            _ => text.line_end(point.position.0)?,
        };
        if end > start {
            result.push(IndexedSegment {
                start,
                end,
                source: point.source,
                original: point.original,
            });
        }
        cursor = end;
    }
    if cursor < byte_len {
        result.push(IndexedSegment {
            start: cursor,
            end: byte_len,
            source: 0,
            original: None,
        });
    }
    Ok(IndexedAttribution {
        segments: result,
        sources: decoder.sources,
        rejected,
    })
}

pub(crate) type Position = (u32, u32);

fn offset_position(base: Position, local: Position) -> Result<Position> {
    Ok((
        base.0
            .checked_add(local.0)
            .ok_or_else(|| anyhow::anyhow!("source-map line overflow"))?,
        if local.0 == 0 {
            base.1
                .checked_add(local.1)
                .ok_or_else(|| anyhow::anyhow!("source-map column overflow"))?
        } else {
            local.1
        },
    ))
}

struct Point {
    position: Position,
    byte: usize,
    source: usize,
    original: Option<OriginalPosition>,
}

struct Decoder<'a> {
    text: &'a TextIndex,
    retain_contents: bool,
    source_paths: Option<&'a crate::source_path::SourcePaths<'a>>,
    points: Vec<Point>,
    sources: Vec<IndexedSource>,
    source_ids: BTreeMap<String, usize>,
    rejected: Vec<(RejectionReason, Mapping)>,
}

impl Decoder<'_> {
    fn collect(&mut self, map: &DecodedMap, offset: Position, end: Option<Position>) -> Result<()> {
        match map {
            DecodedMap::Hermes(_) => bail!("Hermes source maps are unsupported"),
            DecodedMap::Index(index) => {
                let sections = index.sections().collect::<Vec<_>>();
                let starts = sections
                    .iter()
                    .map(|s| offset_position(offset, s.get_offset()))
                    .collect::<Result<Vec<_>>>()?;
                ensure!(
                    starts.windows(2).all(|pair| pair[0] < pair[1]),
                    "index-map sections must be strictly ordered"
                );
                for (i, section) in sections.iter().enumerate() {
                    let start = starts[i];
                    ensure!(
                        end.is_none_or(|end| start < end),
                        "index-map section starts outside its parent section"
                    );
                    let byte = self.text.position(start.0, start.1)?;
                    self.points.push(Point {
                        position: start,
                        byte,
                        source: 0,
                        original: None,
                    });
                    self.collect(
                        section.get_sourcemap().ok_or_else(|| {
                            anyhow::anyhow!("index-map section has no embedded map")
                        })?,
                        start,
                        starts.get(i + 1).copied().or(end),
                    )?;
                }
            }
            DecodedMap::Regular(map) => {
                // Resolve each source path once per map, never once per token.
                let raw: Vec<&str> = (0..map.get_source_count())
                    .map(|i| map.get_source(i).unwrap_or(UNMAPPED))
                    .collect();
                let resolved: Vec<String> = raw
                    .iter()
                    .map(|&source| {
                        self.source_paths
                            .map_or_else(|| source.to_owned(), |paths| paths.resolve(source))
                    })
                    .collect();
                let mut spellings: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
                for (i, name) in (0..).zip(&resolved) {
                    spellings.entry(name).or_default().push(i);
                }
                let mut ids = Vec::with_capacity(raw.len());
                for i in 0..map.get_source_count() {
                    let (raw, resolved) = (raw[i as usize], &resolved[i as usize]);
                    // Spellings that resolve alike but carry different contents are different
                    // modules (vue-loader emits compiled `./x.vue` beside the original `x.vue`).
                    let content = map.get_source_contents(i);
                    let distinct = raw != resolved
                        && content.is_some()
                        && spellings[resolved.as_str()].iter().any(|&j| {
                            map.get_source_contents(j)
                                .is_some_and(|other| Some(other) != content)
                        });
                    let source = if distinct {
                        raw.to_owned()
                    } else {
                        resolved.clone()
                    };
                    let id = if let Some(&id) = self.source_ids.get(&source) {
                        id
                    } else {
                        let id = self.sources.len();
                        self.sources.push(IndexedSource {
                            name: source.clone(),
                            content: None,
                        });
                        self.source_ids.insert(source.clone(), id);
                        id
                    };
                    if self.retain_contents
                        && let Some(content) = map.get_source_contents(i)
                    {
                        if let Some(previous) = &self.sources[id].content {
                            ensure!(
                                previous == content,
                                "conflicting sourcesContent for {source}"
                            );
                        } else {
                            self.sources[id].content = Some(content.into());
                        }
                    }
                    ids.push(id);
                }
                self.points.reserve(map.get_token_count() as usize);
                for token in map.tokens() {
                    let position =
                        offset_position(offset, (token.get_dst_line(), token.get_dst_col()))?;
                    ensure!(
                        end.is_none_or(|end| position <= end),
                        "source-map mapping overlaps the next section"
                    );
                    if end == Some(position) {
                        continue;
                    }
                    self.text.line_end(position.0)?;
                    let source = ids.get(token.get_src_id() as usize).copied().unwrap_or(0);
                    let original = token.get_source().map(|_| OriginalPosition {
                        line: token.get_src_line(),
                        column: token.get_src_col(),
                    });
                    let Ok(byte) = self.text.position(position.0, position.1) else {
                        let reason = if self.text.line_len(position.0)? < position.1 as usize {
                            RejectionReason::ColumnOutsideLine
                        } else {
                            RejectionReason::InsideSurrogatePair
                        };
                        let mapping = Mapping {
                            generated: position,
                            source,
                            original,
                        };
                        self.rejected.push((reason, mapping));
                        continue;
                    };
                    self.points.push(Point {
                        position,
                        byte,
                        source,
                        original,
                    });
                }
            }
        }
        Ok(())
    }
}

fn validate_map(map: &serde_json::Value) -> Result<()> {
    ensure!(
        map.get("version").and_then(|value| value.as_u64()) == Some(3),
        "source map must declare version 3"
    );
    if let Some(sections) = map.get("sections") {
        let sections = sections
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("sections must be an array"))?;
        let mut previous = None;
        for section in sections {
            let offset = section
                .get("offset")
                .ok_or_else(|| anyhow::anyhow!("index-map section has no offset"))?;
            let coordinate = |key: &str| -> Result<u32> {
                offset
                    .get(key)
                    .and_then(|v| v.as_u64())
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or_else(|| {
                        anyhow::anyhow!("index-map offset {key} must be a nonnegative u32")
                    })
            };
            let position = (coordinate("line")?, coordinate("column")?);
            ensure!(
                previous.is_none_or(|previous| previous < position),
                "index-map sections must be strictly ordered"
            );
            previous = Some(position);
            ensure!(
                section.get("url").is_none(),
                "external index-map sections are unsupported; supply embedded maps"
            );
            validate_map(
                section
                    .get("map")
                    .ok_or_else(|| anyhow::anyhow!("index-map section has no map"))?,
            )?;
        }
    } else {
        ensure!(
            map.get("sources").is_some_and(|value| value.is_array()),
            "source map has no sources array"
        );
        ensure!(
            map.get("mappings").is_some_and(|value| value.is_string()),
            "source map has no mappings string"
        );
    }
    Ok(())
}

/// The package of every source outside `node_modules`.
pub const APPLICATION: &str = "[application]";

pub fn package(source: &str) -> String {
    if source == UNMAPPED {
        return UNMAPPED.into();
    }
    let normalized = source.replace('\\', "/");
    if let Some((_, rest)) = normalized.rsplit_once("node_modules/") {
        let mut parts = rest.split('/');
        let first = parts.next().unwrap_or_default();
        if first.starts_with('@') {
            return format!("{first}/{}", parts.next().unwrap_or_default());
        }
        return first.to_owned();
    }
    APPLICATION.into()
}
