//! UTF-8 byte offset -> UTF-16 code-unit offset mapping.
//!
//! oxc spans are UTF-8 byte offsets; CONTRACT requires UTF-16 code units.
//! Implemented in P3-W2 (Task 2).

/// Line index over UTF-16 code-unit offsets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Utf16LineIndex {
    line_starts: Vec<u32>,
}

impl Utf16LineIndex {
    #[must_use]
    pub fn new(source: &str) -> Self {
        let mut line_starts = vec![0];
        let mut offset = 0_u32;

        for ch in source.chars() {
            offset += if ch.len_utf16() == 1 { 1 } else { 2 };
            if ch == '\n' {
                line_starts.push(offset);
            }
        }

        Self { line_starts }
    }

    #[must_use]
    pub fn position(&self, utf16_offset: u32) -> (u32, u32) {
        let line_index = self
            .line_starts
            .partition_point(|start| *start <= utf16_offset);
        let line = line_index.saturating_sub(1);
        let line_start = self.line_starts[line];
        (
            u32::try_from(line).unwrap_or(u32::MAX),
            utf16_offset.saturating_sub(line_start),
        )
    }
}

/// Maps UTF-8 byte offsets (oxc spans) to UTF-16 code-unit offsets (CONTRACT §2).
pub struct Utf16Mapper {
    // Precomputed mapping: Vec of (byte_offset, utf16_offset) at char boundaries
    mapping: Vec<(u32, u32)>,
    newline_utf16_offsets: Vec<u32>,
    source_len: u32,
}

impl Utf16Mapper {
    /// Build from the full source text.
    #[must_use]
    pub fn new(source: &str) -> Self {
        let mut mapping = vec![(0, 0)];
        let mut newline_utf16_offsets = Vec::new();
        let mut byte_offset = 0u32;
        let mut utf16_offset = 0u32;

        for ch in source.chars() {
            if ch == '\n' {
                newline_utf16_offsets.push(utf16_offset);
            }
            byte_offset += u32::try_from(ch.len_utf8()).unwrap_or(u32::MAX);
            utf16_offset += u32::try_from(ch.len_utf16()).unwrap_or(u32::MAX);
            mapping.push((byte_offset, utf16_offset));
        }

        let source_len = u32::try_from(source.len()).unwrap_or(u32::MAX);

        Self {
            mapping,
            newline_utf16_offsets,
            source_len,
        }
    }

    /// Convert a UTF-8 byte offset (must be a char boundary, or end of string)
    /// to a UTF-16 code-unit offset. Offsets past end clamp to the UTF-16 length.
    #[must_use]
    pub fn to_utf16(&self, byte_offset: u32) -> u32 {
        // Clamp to source length
        let byte_offset = byte_offset.min(self.source_len);

        // Binary search for the mapping entry
        match self.mapping.binary_search_by_key(&byte_offset, |&(b, _)| b) {
            Ok(idx) => self.mapping[idx].1,
            Err(idx) => {
                // idx is the insertion point; the previous entry is the closest
                if idx > 0 { self.mapping[idx - 1].1 } else { 0 }
            }
        }
    }

    /// Convert a UTF-16 code-unit offset into a zero-based line and character
    /// pair. Lines advance only on `\n`, matching JavaScript's
    /// `sourceText.charCodeAt(i) === 10` scan.
    #[must_use]
    pub fn line_and_character_for_utf16(&self, utf16_offset: u32) -> (u32, u32) {
        let source_utf16_len = self.mapping.last().map_or(0, |&(_, offset)| offset);
        let utf16_offset = utf16_offset.min(source_utf16_len);
        let newline_count = self
            .newline_utf16_offsets
            .partition_point(|&newline_offset| newline_offset < utf16_offset);
        let line = u32::try_from(newline_count).unwrap_or(u32::MAX);
        let character = self
            .newline_utf16_offsets
            .get(newline_count.saturating_sub(1))
            .map_or(utf16_offset, |last_newline| {
                utf16_offset.saturating_sub(*last_newline + 1)
            });
        (line, character)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    fn reference_utf16_offset(source: &str, byte_offset: u32) -> u32 {
        let byte_offset = (byte_offset as usize).min(source.len());
        source[..byte_offset]
            .chars()
            .map(|ch| u32::try_from(ch.len_utf16()).unwrap_or(u32::MAX))
            .sum()
    }

    fn test_all_char_boundaries(source: &str, mapper: &Utf16Mapper, test_name: &str) {
        let mut byte_offset = 0;
        for ch in source.chars() {
            let result = mapper.to_utf16(u32::try_from(byte_offset).unwrap_or(u32::MAX));
            let expected =
                reference_utf16_offset(source, u32::try_from(byte_offset).unwrap_or(u32::MAX));
            assert_eq!(
                result, expected,
                "{test_name}: byte_offset={byte_offset} expected={expected} got={result}"
            );
            byte_offset += ch.len_utf8();
        }
        // Also test at end
        let result = mapper.to_utf16(u32::try_from(source.len()).unwrap_or(u32::MAX));
        let expected =
            reference_utf16_offset(source, u32::try_from(source.len()).unwrap_or(u32::MAX));
        assert_eq!(
            result,
            expected,
            "{test_name}: end byte_offset={} expected={expected} got={result}",
            source.len()
        );
    }

    #[test]
    fn test_pure_ascii() {
        let source = "hello";
        let mapper = Utf16Mapper::new(source);

        // Test at every char boundary (ASCII is 1 byte per char)
        for byte_offset in 0..=u32::try_from(source.len()).unwrap_or(u32::MAX) {
            let result = mapper.to_utf16(byte_offset);
            let expected = reference_utf16_offset(source, byte_offset);
            assert_eq!(
                result, expected,
                "ASCII: byte_offset={byte_offset} expected={expected} got={result}"
            );
        }
    }

    #[test]
    fn test_emoji_surrogate_pair() {
        // 🦀 is U+1F980, which is 4 UTF-8 bytes and 2 UTF-16 code units
        let source = "a🦀b";
        let mapper = Utf16Mapper::new(source);

        test_all_char_boundaries(source, &mapper, "emoji");
    }

    #[rstest]
    #[case(0, 0, "start")]
    #[case(1, 1, "after 'a'")]
    #[case(5, 3, "after emoji (2 UTF-16 units)")]
    #[case(6, 4, "end")]
    fn test_emoji_surrogate_pair_explicit_offsets(
        #[case] byte_offset: u32,
        #[case] expected: u32,
        #[case] message: &str,
    ) {
        // 🦀 is U+1F980, which is 4 UTF-8 bytes and 2 UTF-16 code units
        let source = "a🦀b";
        let mapper = Utf16Mapper::new(source);

        // Byte offsets: a=0-1, 🦀=1-5, b=5-6
        // UTF-16 offsets: a=0-1, 🦀=1-3, b=3-4
        assert_eq!(mapper.to_utf16(byte_offset), expected, "{message}");
    }

    #[test]
    fn test_cjk() {
        // 中 is U+4E2D (3 UTF-8 bytes, 1 UTF-16 unit)
        // 文 is U+6587 (3 UTF-8 bytes, 1 UTF-16 unit)
        let source = "中文";
        let mapper = Utf16Mapper::new(source);

        test_all_char_boundaries(source, &mapper, "CJK");
    }

    #[rstest]
    #[case(0, 0, "start")]
    #[case(3, 1, "after 中")]
    #[case(6, 2, "after 文")]
    fn test_cjk_explicit_offsets(
        #[case] byte_offset: u32,
        #[case] expected: u32,
        #[case] message: &str,
    ) {
        // 中 is U+4E2D (3 UTF-8 bytes, 1 UTF-16 unit)
        // 文 is U+6587 (3 UTF-8 bytes, 1 UTF-16 unit)
        let source = "中文";
        let mapper = Utf16Mapper::new(source);

        assert_eq!(mapper.to_utf16(byte_offset), expected, "{message}");
    }

    #[test]
    fn test_combining_marks() {
        // e + combining acute accent (U+0301)
        let source = "e\u{0301}";
        let mapper = Utf16Mapper::new(source);

        test_all_char_boundaries(source, &mapper, "combining");
    }

    #[rstest]
    #[case(0, 0, "start")]
    #[case(1, 1, "after e")]
    #[case(3, 2, "after combining mark")]
    fn test_combining_marks_explicit_offsets(
        #[case] byte_offset: u32,
        #[case] expected: u32,
        #[case] message: &str,
    ) {
        // e + combining acute accent (U+0301)
        let source = "e\u{0301}";
        let mapper = Utf16Mapper::new(source);

        // e = 1 byte, 1 UTF-16 unit
        // U+0301 = 2 bytes, 1 UTF-16 unit
        assert_eq!(mapper.to_utf16(byte_offset), expected, "{message}");
    }

    #[test]
    fn test_bom() {
        // BOM (U+FEFF) = 3 UTF-8 bytes, 1 UTF-16 unit
        let source = "\u{FEFF}use";
        let mapper = Utf16Mapper::new(source);

        test_all_char_boundaries(source, &mapper, "BOM");
    }

    #[rstest]
    #[case(0, 0, "start")]
    #[case(3, 1, "after BOM")]
    #[case(4, 2, "after 'u'")]
    #[case(7, 4, "end")]
    fn test_bom_explicit_offsets(
        #[case] byte_offset: u32,
        #[case] expected: u32,
        #[case] message: &str,
    ) {
        // BOM (U+FEFF) = 3 UTF-8 bytes, 1 UTF-16 unit
        let source = "\u{FEFF}use";
        let mapper = Utf16Mapper::new(source);

        assert_eq!(mapper.to_utf16(byte_offset), expected, "{message}");
    }

    #[test]
    fn test_crlf() {
        let source = "a\r\nb";
        let mapper = Utf16Mapper::new(source);

        test_all_char_boundaries(source, &mapper, "CRLF");
    }

    #[rstest]
    #[case(0, 0, "start")]
    #[case(1, 1, "after 'a'")]
    #[case(2, 2, "after \\r")]
    #[case(3, 3, "after \\n")]
    #[case(4, 4, "end")]
    fn test_crlf_explicit_offsets(
        #[case] byte_offset: u32,
        #[case] expected: u32,
        #[case] message: &str,
    ) {
        let source = "a\r\nb";
        let mapper = Utf16Mapper::new(source);

        // a = 1 byte, 1 UTF-16 unit
        // \r = 1 byte, 1 UTF-16 unit
        // \n = 1 byte, 1 UTF-16 unit
        // b = 1 byte, 1 UTF-16 unit
        assert_eq!(mapper.to_utf16(byte_offset), expected, "{message}");
    }

    #[test]
    fn test_mixed_string() {
        // Mix of ASCII, emoji, CJK, combining marks
        let source = "a🦀中e\u{0301}";
        let mapper = Utf16Mapper::new(source);

        test_all_char_boundaries(source, &mapper, "mixed");
    }

    #[rstest]
    #[case(0, 0, "start")]
    #[case(1, 1, "after 'a'")]
    #[case(5, 3, "after emoji")]
    #[case(8, 4, "after CJK")]
    #[case(9, 5, "after 'e'")]
    #[case(11, 6, "end")]
    fn test_mixed_string_explicit_offsets(
        #[case] byte_offset: u32,
        #[case] expected: u32,
        #[case] message: &str,
    ) {
        // Mix of ASCII, emoji, CJK, combining marks
        let source = "a🦀中e\u{0301}";
        let mapper = Utf16Mapper::new(source);

        // a = 1 byte, 1 UTF-16 unit
        // 🦀 = 4 bytes, 2 UTF-16 units
        // 中 = 3 bytes, 1 UTF-16 unit
        // e = 1 byte, 1 UTF-16 unit
        // U+0301 = 2 bytes, 1 UTF-16 unit
        // Total: 11 bytes, 6 UTF-16 units
        assert_eq!(mapper.to_utf16(byte_offset), expected, "{message}");
    }

    #[test]
    fn test_offset_past_end_clamped() {
        let source = "hello";
        let mapper = Utf16Mapper::new(source);

        // Offsets past end should clamp to source length
        assert_eq!(mapper.to_utf16(100), 5, "clamped to end");
        assert_eq!(mapper.to_utf16(1000), 5, "clamped to end (large)");
    }

    #[test]
    fn to_utf16_returns_exact_mapping_entry_for_multibyte_boundary() {
        let source = "a🦀b";
        let mapper = Utf16Mapper::new(source);

        assert_eq!(mapper.to_utf16(5), 3, "exact boundary after emoji");
    }

    #[test]
    fn to_utf16_returns_zero_before_first_mapping_entry() {
        let mapper = Utf16Mapper {
            mapping: vec![(2, 1)],
            newline_utf16_offsets: Vec::new(),
            source_len: 2,
        };

        assert_eq!(mapper.to_utf16(1), 0, "before first mapping entry");
    }

    #[test]
    fn test_empty_string() {
        let source = "";
        let mapper = Utf16Mapper::new(source);

        assert_eq!(mapper.to_utf16(0), 0, "empty string");
        assert_eq!(mapper.to_utf16(1), 0, "empty string clamped");
    }

    #[rstest]
    #[case(0, (0, 0))]
    #[case(3, (0, 3))]
    #[case(4, (1, 0))]
    #[case(7, (1, 3))]
    fn ascii_offsets_map_to_zero_based_positions(
        #[case] offset: u32,
        #[case] expected: (u32, u32),
    ) {
        let index = Utf16LineIndex::new("abc\ndef");

        assert_eq!(index.position(offset), expected);
    }

    #[rstest]
    #[case(1, (0, 1))]
    #[case(3, (0, 3))]
    #[case(4, (0, 4))]
    #[case(5, (1, 0))]
    fn emoji_counts_as_two_utf16_units(#[case] offset: u32, #[case] expected: (u32, u32)) {
        let index = Utf16LineIndex::new("a😀b\n c");

        assert_eq!(index.position(offset), expected);
    }

    #[rstest]
    #[case(2, (0, 2))]
    #[case(3, (1, 0))]
    #[case(4, (1, 1))]
    fn cjk_counts_as_one_utf16_unit_per_scalar(#[case] offset: u32, #[case] expected: (u32, u32)) {
        let index = Utf16LineIndex::new("한글\n語");

        assert_eq!(index.position(offset), expected);
    }

    #[rstest]
    #[case(2, (0, 2))]
    #[case(3, (0, 3))]
    #[case(4, (1, 0))]
    fn crlf_treats_carriage_return_as_line_character(
        #[case] offset: u32,
        #[case] expected: (u32, u32),
    ) {
        let index = Utf16LineIndex::new("ab\r\ncd");

        assert_eq!(index.position(offset), expected);
    }

    #[rstest]
    #[case(0, (0, 0))]
    #[case(1, (0, 1))]
    #[case(2, (0, 2))]
    #[case(3, (1, 0))]
    fn bom_is_a_normal_utf16_unit_for_positions(#[case] offset: u32, #[case] expected: (u32, u32)) {
        let index = Utf16LineIndex::new("\u{feff}x\ny");

        assert_eq!(index.position(offset), expected);
    }

    #[rstest]
    #[case(4, (1, 0))]
    #[case(7, (1, 3))]
    #[case(8, (2, 0))]
    #[case(13, (2, 5))]
    fn multiline_offsets_use_nearest_line_start(#[case] offset: u32, #[case] expected: (u32, u32)) {
        let index = Utf16LineIndex::new("one\ntwo\nthree");

        assert_eq!(index.position(offset), expected);
    }
}
