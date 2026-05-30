//! UTF-8 byte offset -> UTF-16 code-unit offset mapping.
//!
//! oxc spans are UTF-8 byte offsets; CONTRACT requires UTF-16 code units.
//! Implemented in P3-W2 (Task 2).

/// Maps UTF-8 byte offsets (oxc spans) to UTF-16 code-unit offsets (CONTRACT §2).
pub struct Utf16Mapper {
    // Precomputed mapping: Vec of (byte_offset, utf16_offset) at char boundaries
    mapping: Vec<(u32, u32)>,
    source_len: u32,
}

impl Utf16Mapper {
    /// Build from the full source text.
    #[must_use]
    pub fn new(source: &str) -> Self {
        let mut mapping = vec![(0, 0)];
        let mut byte_offset = 0u32;
        let mut utf16_offset = 0u32;

        for ch in source.chars() {
            byte_offset += u32::try_from(ch.len_utf8()).unwrap_or(u32::MAX);
            utf16_offset += u32::try_from(ch.len_utf16()).unwrap_or(u32::MAX);
            mapping.push((byte_offset, utf16_offset));
        }

        let source_len = u32::try_from(source.len()).unwrap_or(u32::MAX);

        Self {
            mapping,
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
}

#[cfg(test)]
mod tests {
    use super::*;

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

        // Byte offsets: a=0-1, 🦀=1-5, b=5-6
        // UTF-16 offsets: a=0-1, 🦀=1-3, b=3-4

        assert_eq!(mapper.to_utf16(0), 0, "start");
        assert_eq!(mapper.to_utf16(1), 1, "after 'a'");
        assert_eq!(mapper.to_utf16(5), 3, "after emoji (2 UTF-16 units)");
        assert_eq!(mapper.to_utf16(6), 4, "end");

        test_all_char_boundaries(source, &mapper, "emoji");
    }

    #[test]
    fn test_cjk() {
        // 中 is U+4E2D (3 UTF-8 bytes, 1 UTF-16 unit)
        // 文 is U+6587 (3 UTF-8 bytes, 1 UTF-16 unit)
        let source = "中文";
        let mapper = Utf16Mapper::new(source);

        assert_eq!(mapper.to_utf16(0), 0, "start");
        assert_eq!(mapper.to_utf16(3), 1, "after 中");
        assert_eq!(mapper.to_utf16(6), 2, "after 文");

        test_all_char_boundaries(source, &mapper, "CJK");
    }

    #[test]
    fn test_combining_marks() {
        // e + combining acute accent (U+0301)
        let source = "e\u{0301}";
        let mapper = Utf16Mapper::new(source);

        // e = 1 byte, 1 UTF-16 unit
        // U+0301 = 2 bytes, 1 UTF-16 unit
        assert_eq!(mapper.to_utf16(0), 0, "start");
        assert_eq!(mapper.to_utf16(1), 1, "after e");
        assert_eq!(mapper.to_utf16(3), 2, "after combining mark");

        test_all_char_boundaries(source, &mapper, "combining");
    }

    #[test]
    fn test_bom() {
        // BOM (U+FEFF) = 3 UTF-8 bytes, 1 UTF-16 unit
        let source = "\u{FEFF}use";
        let mapper = Utf16Mapper::new(source);

        assert_eq!(mapper.to_utf16(0), 0, "start");
        assert_eq!(mapper.to_utf16(3), 1, "after BOM");
        assert_eq!(mapper.to_utf16(4), 2, "after 'u'");
        assert_eq!(mapper.to_utf16(7), 4, "end");

        test_all_char_boundaries(source, &mapper, "BOM");
    }

    #[test]
    fn test_crlf() {
        let source = "a\r\nb";
        let mapper = Utf16Mapper::new(source);

        // a = 1 byte, 1 UTF-16 unit
        // \r = 1 byte, 1 UTF-16 unit
        // \n = 1 byte, 1 UTF-16 unit
        // b = 1 byte, 1 UTF-16 unit
        assert_eq!(mapper.to_utf16(0), 0, "start");
        assert_eq!(mapper.to_utf16(1), 1, "after 'a'");
        assert_eq!(mapper.to_utf16(2), 2, "after \\r");
        assert_eq!(mapper.to_utf16(3), 3, "after \\n");
        assert_eq!(mapper.to_utf16(4), 4, "end");

        test_all_char_boundaries(source, &mapper, "CRLF");
    }

    #[test]
    fn test_mixed_string() {
        // Mix of ASCII, emoji, CJK, combining marks
        let source = "a🦀中e\u{0301}";
        let mapper = Utf16Mapper::new(source);

        // a = 1 byte, 1 UTF-16 unit
        // 🦀 = 4 bytes, 2 UTF-16 units
        // 中 = 3 bytes, 1 UTF-16 unit
        // e = 1 byte, 1 UTF-16 unit
        // U+0301 = 2 bytes, 1 UTF-16 unit
        // Total: 11 bytes, 6 UTF-16 units

        assert_eq!(mapper.to_utf16(0), 0, "start");
        assert_eq!(mapper.to_utf16(1), 1, "after 'a'");
        assert_eq!(mapper.to_utf16(5), 3, "after emoji");
        assert_eq!(mapper.to_utf16(8), 4, "after CJK");
        assert_eq!(mapper.to_utf16(9), 5, "after 'e'");
        assert_eq!(mapper.to_utf16(11), 6, "end");

        test_all_char_boundaries(source, &mapper, "mixed");
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
    fn test_empty_string() {
        let source = "";
        let mapper = Utf16Mapper::new(source);

        assert_eq!(mapper.to_utf16(0), 0, "empty string");
        assert_eq!(mapper.to_utf16(1), 0, "empty string clamped");
    }
}
