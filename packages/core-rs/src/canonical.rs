//! Canonical compact-JSON serializer (CONTRACT §3.3/§3.4): dedup, total order,
//! fixed field order, raw UTF-8, integer offsets. Operates on [`crate::Usage`].

use crate::Usage;

/// Normalize a path to canonical form: forward slashes + lowercased drive letter (CONTRACT §4).
#[must_use]
pub fn normalize_path(path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        let drive = normalized.as_bytes()[0];
        if (drive as char).is_ascii_uppercase() {
            let mut chars = normalized.chars();
            if let Some(first) = chars.next() {
                normalized = first.to_lowercase().to_string() + chars.as_str();
            }
        }
    }
    normalized
}

/// Canonical compact-JSON serialization (CONTRACT §3.4): dedup by full tuple,
/// total order per §3.3, fixed field order kind/tagName/sourceFilePath/ranges.
/// Mutates `usages` (sorts/dedups). Byte-identical to the TS oracle.
#[must_use]
pub fn serialize_canonical(usages: &mut [Usage]) -> String {
    // Normalize paths and sort ranges within each usage
    for usage in usages.iter_mut() {
        usage.source_file_path = normalize_path(&usage.source_file_path);
        usage.ranges.sort_by(|a, b| {
            if a.start == b.start {
                a.end.cmp(&b.end)
            } else {
                a.start.cmp(&b.start)
            }
        });
    }

    // Dedup by full tuple (kind, tagName, sourceFilePath, ranges)
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::new();
    for usage in usages.iter() {
        let key = serialize_usage(usage);
        if seen.insert(key) {
            deduped.push(usage.clone());
        }
    }

    // Sort by canonical order
    deduped.sort_by(compare_canonical);

    // Serialize to compact JSON
    let mut out = String::from("[");
    for (i, usage) in deduped.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&serialize_usage(usage));
    }
    out.push(']');
    out
}

/// Serialize a single usage to compact JSON.
fn serialize_usage(usage: &Usage) -> String {
    use std::fmt::Write;

    let mut ranges_json = String::from("[");
    for (i, range) in usage.ranges.iter().enumerate() {
        if i > 0 {
            ranges_json.push(',');
        }
        let _ = write!(
            ranges_json,
            r#"{{"start":{},"end":{}}}"#,
            range.start, range.end
        );
    }
    ranges_json.push(']');

    format!(
        r#"{{"kind":{},"tagName":{},"sourceFilePath":{},"ranges":{}}}"#,
        serde_json::to_string(usage.kind.as_str()).unwrap(),
        serde_json::to_string(&usage.tag_name).unwrap(),
        serde_json::to_string(&usage.source_file_path).unwrap(),
        ranges_json
    )
}

/// Compare two usages for canonical ordering (CONTRACT §3.3).
fn compare_canonical(a: &Usage, b: &Usage) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    // 1. ranges[0].start
    let a_first = a.ranges.first();
    let b_first = b.ranges.first();
    match (a_first, b_first) {
        (Some(af), Some(bf)) => {
            if af.start != bf.start {
                return af.start.cmp(&bf.start);
            }
            // 2. ranges[0].end
            if af.end != bf.end {
                return af.end.cmp(&bf.end);
            }
        }
        (Some(_), None) => return Ordering::Greater,
        (None, Some(_)) => return Ordering::Less,
        (None, None) => {}
    }

    // 3. kind ("client" < "server")
    if a.kind != b.kind {
        return a.kind.cmp(&b.kind);
    }

    // 4. tagName (lexicographic)
    if a.tag_name != b.tag_name {
        return a.tag_name.cmp(&b.tag_name);
    }

    // 5. sourceFilePath (lexicographic)
    if a.source_file_path != b.source_file_path {
        return a.source_file_path.cmp(&b.source_file_path);
    }

    // 6. remaining ranges pairwise, then by length
    let shared = a.ranges.len().min(b.ranges.len());
    for i in 1..shared {
        let a_range = &a.ranges[i];
        let b_range = &b.ranges[i];
        if a_range.start != b_range.start {
            return a_range.start.cmp(&b_range.start);
        }
        if a_range.end != b_range.end {
            return a_range.end.cmp(&b_range.end);
        }
    }
    a.ranges.len().cmp(&b.ranges.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Kind, Range};

    #[test]
    fn test_normalize_path_windows_uppercase_drive() {
        assert_eq!(normalize_path("C:\\a\\b\\Page.tsx"), "c:/a/b/Page.tsx");
    }

    #[test]
    fn test_normalize_path_posix() {
        assert_eq!(normalize_path("/home/user/Page.tsx"), "/home/user/Page.tsx");
    }

    #[test]
    fn test_normalize_path_mixed_separators() {
        assert_eq!(normalize_path("D:\\Mixed/Path.tsx"), "d:/Mixed/Path.tsx");
    }

    #[test]
    fn test_serialize_canonical_single_usage() {
        let mut usages = vec![Usage {
            kind: Kind::Client,
            tag_name: "A".to_string(),
            source_file_path: "/proj/A.tsx".to_string(),
            ranges: vec![Range { start: 1, end: 7 }],
        }];
        let result = serialize_canonical(&mut usages);
        assert_eq!(
            result,
            r#"[{"kind":"client","tagName":"A","sourceFilePath":"/proj/A.tsx","ranges":[{"start":1,"end":7}]}]"#
        );
    }

    #[test]
    fn test_serialize_canonical_non_ascii_path() {
        let mut usages = vec![Usage {
            kind: Kind::Client,
            tag_name: "A".to_string(),
            source_file_path: "/프로젝트/A.tsx".to_string(),
            ranges: vec![Range { start: 1, end: 7 }],
        }];
        let result = serialize_canonical(&mut usages);
        // Should output raw UTF-8, not \u-escaped
        assert_eq!(
            result,
            r#"[{"kind":"client","tagName":"A","sourceFilePath":"/프로젝트/A.tsx","ranges":[{"start":1,"end":7}]}]"#
        );
    }

    #[test]
    fn test_serialize_canonical_multiple_usages_in_order() {
        let mut usages = vec![
            Usage {
                kind: Kind::Server,
                tag_name: "A".to_string(),
                source_file_path: "/p/A.tsx".to_string(),
                ranges: vec![Range { start: 1, end: 7 }],
            },
            Usage {
                kind: Kind::Client,
                tag_name: "B".to_string(),
                source_file_path: "/p/B.tsx".to_string(),
                ranges: vec![Range { start: 24, end: 30 }],
            },
        ];
        let result = serialize_canonical(&mut usages);
        assert_eq!(
            result,
            r#"[{"kind":"server","tagName":"A","sourceFilePath":"/p/A.tsx","ranges":[{"start":1,"end":7}]},{"kind":"client","tagName":"B","sourceFilePath":"/p/B.tsx","ranges":[{"start":24,"end":30}]}]"#
        );
    }

    #[test]
    fn test_serialize_canonical_dedup() {
        let mut usages = vec![
            Usage {
                kind: Kind::Client,
                tag_name: "A".to_string(),
                source_file_path: "/p/A.tsx".to_string(),
                ranges: vec![Range { start: 1, end: 7 }],
            },
            Usage {
                kind: Kind::Client,
                tag_name: "A".to_string(),
                source_file_path: "/p/A.tsx".to_string(),
                ranges: vec![Range { start: 1, end: 7 }],
            },
        ];
        let result = serialize_canonical(&mut usages);
        // Should only have one usage
        assert_eq!(
            result,
            r#"[{"kind":"client","tagName":"A","sourceFilePath":"/p/A.tsx","ranges":[{"start":1,"end":7}]}]"#
        );
    }

    #[test]
    fn test_serialize_canonical_ranges_sorted_within_usage() {
        let mut usages = vec![Usage {
            kind: Kind::Server,
            tag_name: "A".to_string(),
            source_file_path: "/p/A.tsx".to_string(),
            ranges: vec![Range { start: 10, end: 12 }, Range { start: 1, end: 7 }],
        }];
        let result = serialize_canonical(&mut usages);
        assert_eq!(
            result,
            r#"[{"kind":"server","tagName":"A","sourceFilePath":"/p/A.tsx","ranges":[{"start":1,"end":7},{"start":10,"end":12}]}]"#
        );
    }

    #[test]
    fn test_compare_tie_break_first_range_end() {
        let mut usages = vec![
            Usage {
                kind: Kind::Server,
                tag_name: "B".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 1, end: 9 }],
            },
            Usage {
                kind: Kind::Server,
                tag_name: "A".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 1, end: 7 }],
            },
        ];
        let result = serialize_canonical(&mut usages);
        // A (end=7) should come before B (end=9)
        assert!(result.contains(r#""tagName":"A""#));
        let a_pos = result.find(r#""tagName":"A""#).unwrap();
        let b_pos = result.find(r#""tagName":"B""#).unwrap();
        assert!(a_pos < b_pos);
    }

    #[test]
    fn test_compare_tie_break_kind() {
        let mut usages = vec![
            Usage {
                kind: Kind::Server,
                tag_name: "A".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 6 }],
            },
            Usage {
                kind: Kind::Client,
                tag_name: "A".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 6 }],
            },
        ];
        let result = serialize_canonical(&mut usages);
        // client should come before server
        let client_pos = result.find(r#""kind":"client""#).unwrap();
        let server_pos = result.find(r#""kind":"server""#).unwrap();
        assert!(client_pos < server_pos);
    }

    #[test]
    fn test_compare_tie_break_tag_name() {
        let mut usages = vec![
            Usage {
                kind: Kind::Server,
                tag_name: "Bbb".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 6 }],
            },
            Usage {
                kind: Kind::Server,
                tag_name: "Aaa".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 6 }],
            },
        ];
        let result = serialize_canonical(&mut usages);
        // Aaa should come before Bbb
        let aaa_pos = result.find(r#""tagName":"Aaa""#).unwrap();
        let bbb_pos = result.find(r#""tagName":"Bbb""#).unwrap();
        assert!(aaa_pos < bbb_pos);
    }

    #[test]
    fn test_compare_tie_break_source_file_path() {
        let mut usages = vec![
            Usage {
                kind: Kind::Server,
                tag_name: "X".to_string(),
                source_file_path: "/p/B.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 6 }],
            },
            Usage {
                kind: Kind::Server,
                tag_name: "X".to_string(),
                source_file_path: "/p/A.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 6 }],
            },
        ];
        let result = serialize_canonical(&mut usages);
        // /p/A.tsx should come before /p/B.tsx
        let a_pos = result.find(r#""/p/A.tsx""#).unwrap();
        let b_pos = result.find(r#""/p/B.tsx""#).unwrap();
        assert!(a_pos < b_pos);
    }

    #[test]
    fn test_compare_tie_break_subsequent_range_and_count() {
        let mut usages = vec![
            Usage {
                kind: Kind::Server,
                tag_name: "A".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 9 }, Range { start: 10, end: 12 }],
            },
            Usage {
                kind: Kind::Server,
                tag_name: "A".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 6 }, Range { start: 7, end: 9 }],
            },
            Usage {
                kind: Kind::Server,
                tag_name: "A".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 6 }],
            },
        ];
        let result = serialize_canonical(&mut usages);
        // Order should be: 1 range (5-6), 2 ranges (5-6, 7-9), 2 ranges (5-9, 10-12)
        let one_range = r#""ranges":[{"start":5,"end":6}]"#;
        let two_ranges_early = r#""ranges":[{"start":5,"end":6},{"start":7,"end":9}]"#;
        let two_ranges_late = r#""ranges":[{"start":5,"end":9},{"start":10,"end":12}]"#;

        let pos1 = result.find(one_range).unwrap();
        let pos2 = result.find(two_ranges_early).unwrap();
        let pos3 = result.find(two_ranges_late).unwrap();
        assert!(pos1 < pos2 && pos2 < pos3);
    }

    #[test]
    fn test_compare_remaining_ranges_loop() {
        let mut usages = vec![
            Usage {
                kind: Kind::Server,
                tag_name: "A".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 6 }, Range { start: 8, end: 9 }],
            },
            Usage {
                kind: Kind::Server,
                tag_name: "A".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 5, end: 6 }, Range { start: 7, end: 9 }],
            },
        ];
        let result = serialize_canonical(&mut usages);
        // Second range start 7 < 8, so second usage comes first
        let early = r#""ranges":[{"start":5,"end":6},{"start":7,"end":9}]"#;
        let late = r#""ranges":[{"start":5,"end":6},{"start":8,"end":9}]"#;
        let early_pos = result.find(early).unwrap();
        let late_pos = result.find(late).unwrap();
        assert!(early_pos < late_pos);
    }

    #[test]
    fn test_compare_empty_ranges() {
        let mut usages = vec![
            Usage {
                kind: Kind::Server,
                tag_name: "Z".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![Range { start: 1, end: 2 }],
            },
            Usage {
                kind: Kind::Server,
                tag_name: "Z".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![],
            },
            Usage {
                kind: Kind::Client,
                tag_name: "Z".to_string(),
                source_file_path: "/p/X.tsx".to_string(),
                ranges: vec![],
            },
        ];
        let result = serialize_canonical(&mut usages);
        // Empty ranges sort before ranged ones, then by kind (client < server)
        let empty_client =
            r#"{"kind":"client","tagName":"Z","sourceFilePath":"/p/X.tsx","ranges":[]}"#;
        let empty_server =
            r#"{"kind":"server","tagName":"Z","sourceFilePath":"/p/X.tsx","ranges":[]}"#;
        let ranged = r#"{"kind":"server","tagName":"Z","sourceFilePath":"/p/X.tsx","ranges":[{"start":1,"end":2}]}"#;

        let client_pos = result.find(empty_client).unwrap();
        let server_pos = result.find(empty_server).unwrap();
        let ranged_pos = result.find(ranged).unwrap();
        assert!(client_pos < server_pos && server_pos < ranged_pos);
    }
}
