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

    #[test]
    fn single_quote_use_client() {
        assert!(has_use_client_directive(b"'use client'"));
    }

    #[test]
    fn double_quote_use_client() {
        assert!(has_use_client_directive(b"\"use client\""));
    }

    #[test]
    fn preceding_directive_use_strict() {
        assert!(has_use_client_directive(b"'use strict'\n'use client'"));
    }

    #[test]
    fn non_directive_token_first() {
        assert!(!has_use_client_directive(b"const x=1\n'use client'"));
    }

    #[test]
    fn line_comment_then_use_client() {
        assert!(has_use_client_directive(b"// comment\n'use client'"));
    }

    #[test]
    fn block_comment_then_use_client() {
        assert!(has_use_client_directive(b"/* comment */'use client'"));
    }

    #[test]
    fn plain_export_function() {
        assert!(!has_use_client_directive(b"export function F(){}"));
    }

    #[test]
    fn escaped_space_not_matched() {
        // "use\u0020client" as raw bytes: u s e \ u 0 0 2 0 c l i e n t
        assert!(!has_use_client_directive(b"\"use\\u0020client\""));
    }

    #[test]
    fn utf8_bom_then_use_client() {
        // UTF-8 BOM (EF BB BF) followed by 'use client'
        assert!(has_use_client_directive(b"\xEF\xBB\xBF'use client'"));
    }

    #[test]
    fn whitespace_then_use_client() {
        assert!(has_use_client_directive(b"  \n\t'use client'"));
    }

    #[test]
    fn semicolon_then_use_client() {
        assert!(has_use_client_directive(b";;'use client'"));
    }

    #[test]
    fn jsx_before_directive() {
        assert!(!has_use_client_directive(b"<div/>;\n'use client'"));
    }

    #[test]
    fn empty_file() {
        assert!(!has_use_client_directive(b""));
    }

    #[test]
    fn only_whitespace() {
        assert!(!has_use_client_directive(b"   \n\t  "));
    }

    #[test]
    fn use_client_not_at_start() {
        assert!(!has_use_client_directive(b"const x = 'use client'"));
    }

    #[test]
    fn use_client_with_extra_text_after_quote() {
        // After the closing quote, there's extra text, but that's OK
        // The directive check only cares about the exact pattern at positions 0-11
        assert!(has_use_client_directive(b"'use client' extra"));
    }

    #[test]
    fn block_comment_not_nested() {
        // Block comments don't nest; /* /* nested */ stops at first */
        // So this becomes: skip to first */, then 'use client' is not at start
        assert!(!has_use_client_directive(b"/* /* nested */ */'use client'"));
    }

    #[test]
    fn multiple_line_comments() {
        assert!(has_use_client_directive(
            b"// comment1\n// comment2\n'use client'"
        ));
    }
}
