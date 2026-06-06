//! `"use client"` directive byte-scanner (CONTRACT §5, verbatim port of
//! `hasUseClientDirective`). Implemented in P3-W2 (Task 3).

/// Returns true iff `source` (raw UTF-8 bytes) begins with a `"use client"`
/// directive per CONTRACT §5. Byte-level; escapes are NOT interpreted.
#[must_use]
pub fn has_use_client_directive(source: &[u8]) -> bool {
    let len = source.len();
    let mut i = 0;

    while i < len {
        let ch = source[i];

        // Skip whitespace/control (<=32), semicolon (59), or BOM (0xEF 0xBB 0xBF)
        if ch <= 32 || ch == 59 {
            i += 1;
            continue;
        }

        // Check for UTF-8 BOM (3 bytes: EF BB BF)
        if i == 0 && i + 3 <= len && source[0] == 0xEF && source[1] == 0xBB && source[2] == 0xBF {
            i += 3;
            continue;
        }

        // Line comment: // -> skip to \n
        if ch == 47 && i + 1 < len {
            let next = source[i + 1];
            if next == 47 {
                i += 2;
                while i < len && source[i] != 10 {
                    i += 1;
                }
                continue;
            }
            // Block comment: /* -> skip to */
            if next == 42 {
                i += 2;
                while i + 1 < len {
                    if source[i] == 42 && source[i + 1] == 47 {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
                continue;
            }
        }

        // String literal: " or '
        if ch == 34 || ch == 39 {
            // Check if this is "use client" or 'use client'
            // Pattern: quote + u(117) s(115) e(101) space(32) c(99) l(108) i(105) e(101) n(110) t(116) + same quote
            if i + 11 < len
                && source[i + 1] == 117  // u
                && source[i + 2] == 115  // s
                && source[i + 3] == 101  // e
                && source[i + 4] == 32   // space
                && source[i + 5] == 99   // c
                && source[i + 6] == 108  // l
                && source[i + 7] == 105  // i
                && source[i + 8] == 101  // e
                && source[i + 9] == 110  // n
                && source[i + 10] == 116 // t
                && source[i + 11] == ch
            // closing quote matches opening
            {
                return true;
            }
            // Skip to closing quote and continue
            i += 1;
            while i < len && source[i] != ch {
                i += 1;
            }
            if i < len {
                i += 1;
            }
            continue;
        }

        // Any other character -> not a client component
        return false;
    }

    // End of input -> not a client component
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[rstest]
    #[case::single_quote_use_client(b"'use client'".as_slice(), true)]
    #[case::double_quote_use_client(b"\"use client\"".as_slice(), true)]
    #[case::preceding_directive_use_strict(b"'use strict'\n'use client'".as_slice(), true)]
    #[case::non_directive_token_first(b"const x=1\n'use client'".as_slice(), false)]
    #[case::line_comment_then_use_client(b"// comment\n'use client'".as_slice(), true)]
    #[case::block_comment_then_use_client(b"/* comment */'use client'".as_slice(), true)]
    #[case::plain_export_function(b"export function F(){}".as_slice(), false)]
    #[case::escaped_space_not_matched(b"\"use\\u0020client\"".as_slice(), false)]
    #[case::utf8_bom_then_use_client(b"\xEF\xBB\xBF'use client'".as_slice(), true)]
    #[case::whitespace_then_use_client(b"  \n\t'use client'".as_slice(), true)]
    #[case::semicolon_then_use_client(b";;'use client'".as_slice(), true)]
    #[case::jsx_before_directive(b"<div/>;\n'use client'".as_slice(), false)]
    #[case::empty_file(b"".as_slice(), false)]
    #[case::only_whitespace(b"   \n\t  ".as_slice(), false)]
    #[case::use_client_not_at_start(b"const x = 'use client'".as_slice(), false)]
    #[case::use_client_with_extra_text_after_quote(b"'use client' extra".as_slice(), true)]
    #[case::block_comment_not_nested(b"/* /* nested */ */'use client'".as_slice(), false)]
    #[case::multiple_line_comments(b"// comment1\n// comment2\n'use client'".as_slice(), true)]
    #[case::long_line_comment_without_newline_scans_to_end(
        b"// comment with no trailing newline".as_slice(),
        false
    )]
    #[case::slash_that_is_not_a_comment_stops_scanning(b"/ not a comment".as_slice(), false)]
    fn has_use_client_directive_cases(#[case] input: &[u8], #[case] expected: bool) {
        assert_eq!(has_use_client_directive(input), expected);
    }
}
