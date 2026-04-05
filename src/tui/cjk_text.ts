/**
 * @file CJK-aware text utilities — character width + word wrap.
 *
 * Provides `charWidth()` for terminal cell width of any character,
 * and `wrapTextCJK()` for column-aware soft wrapping that prevents
 * CJK double-width chars from overflowing the terminal edge.
 */

// ─── Character Width ──────────────────────────────────────────────────────

/**
 * Returns the display width of a character in a terminal.
 * CJK ideographs and fullwidth forms → 2, control chars → 0, others → 1.
 */
export function charWidth(char: string): number {
    const cp = char.codePointAt(0)
    if (cp === undefined) return 0
    if (cp < 0x20) return 0 // control chars
    // CJK Unified Ideographs, Extension A/B
    if (
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x20000 && cp <= 0x2a6df) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        // Fullwidth Forms
        (cp >= 0xff01 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        // CJK Radicals, Kangxi, Ideographic Description
        (cp >= 0x2e80 && cp <= 0x303e) ||
        // Hangul Syllables
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        // CJK Compatibility Ideographs Supplement
        (cp >= 0x2f800 && cp <= 0x2fa1f)
    ) {
        return 2
    }
    return 1
}

/**
 * Returns the display width of a string in terminal cells.
 */
export function stringWidth(str: string): number {
    let w = 0
    for (const ch of str) {
        w += charWidth(ch)
    }
    return w
}

// ─── CJK-Aware Wrapping ──────────────────────────────────────────────────

/**
 * Wraps text into lines that fit within `columns` terminal cells.
 *
 * Unlike Ink's built-in wrapping, this correctly accounts for
 * CJK double-width characters, preventing the "floating char" bug
 * where a 2-cell char overflows onto the next line.
 */
export function wrapTextCJK(text: string, columns: number): string[] {
    if (columns < 1) columns = 1
    const result: string[] = []

    // Split on explicit newlines first
    const paragraphs = text.split('\n')

    for (const para of paragraphs) {
        if (para === '') {
            result.push('')
            continue
        }

        let line = ''
        let lineWidth = 0

        for (const ch of para) {
            const cw = charWidth(ch)

            // If adding this char would exceed columns, start a new line
            if (lineWidth + cw > columns && line.length > 0) {
                result.push(line)
                line = ''
                lineWidth = 0
            }

            line += ch
            lineWidth += cw
        }

        // Push remaining content
        result.push(line)
    }

    return result
}
