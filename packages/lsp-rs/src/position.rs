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

#[cfg(test)]
mod tests {
    use super::Utf16LineIndex;

    #[test]
    fn ascii_offsets_map_to_zero_based_positions() {
        let index = Utf16LineIndex::new("abc\ndef");

        assert_eq!(index.position(0), (0, 0));
        assert_eq!(index.position(3), (0, 3));
        assert_eq!(index.position(4), (1, 0));
        assert_eq!(index.position(7), (1, 3));
    }

    #[test]
    fn emoji_counts_as_two_utf16_units() {
        let index = Utf16LineIndex::new("a😀b\n c");

        assert_eq!(index.position(1), (0, 1));
        assert_eq!(index.position(3), (0, 3));
        assert_eq!(index.position(4), (0, 4));
        assert_eq!(index.position(5), (1, 0));
    }

    #[test]
    fn cjk_counts_as_one_utf16_unit_per_scalar() {
        let index = Utf16LineIndex::new("한글\n語");

        assert_eq!(index.position(2), (0, 2));
        assert_eq!(index.position(3), (1, 0));
        assert_eq!(index.position(4), (1, 1));
    }

    #[test]
    fn crlf_treats_carriage_return_as_line_character() {
        let index = Utf16LineIndex::new("ab\r\ncd");

        assert_eq!(index.position(2), (0, 2));
        assert_eq!(index.position(3), (0, 3));
        assert_eq!(index.position(4), (1, 0));
    }

    #[test]
    fn bom_is_a_normal_utf16_unit_for_positions() {
        let index = Utf16LineIndex::new("\u{feff}x\ny");

        assert_eq!(index.position(0), (0, 0));
        assert_eq!(index.position(1), (0, 1));
        assert_eq!(index.position(2), (0, 2));
        assert_eq!(index.position(3), (1, 0));
    }

    #[test]
    fn multiline_offsets_use_nearest_line_start() {
        let index = Utf16LineIndex::new("one\ntwo\nthree");

        assert_eq!(index.position(4), (1, 0));
        assert_eq!(index.position(7), (1, 3));
        assert_eq!(index.position(8), (2, 0));
        assert_eq!(index.position(13), (2, 5));
    }
}
