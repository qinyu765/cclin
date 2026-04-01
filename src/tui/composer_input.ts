/**
 * @file Editor buffer utilities for TUI input.
 *
 * Ported from memo-code's composer_input.ts — provides:
 * - Surrogate-pair-safe cursor clamping
 * - Character-aware cursor movement
 * - Terminal-width-aware wrapped cursor layout
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type EditorBuffer = {
    value: string
    cursor: number
}

export type WrappedCursorLine = {
    text: string
    start: number
    end: number
}

export type WrappedCursorLayout = {
    lines: WrappedCursorLine[]
    row: number
    cursorInRow: number
}

// ─── Surrogate pair helpers ───────────────────────────────────────────────

const SURROGATE_HIGH_MIN = 0xd800
const SURROGATE_HIGH_MAX = 0xdbff
const SURROGATE_LOW_MIN = 0xdc00
const SURROGATE_LOW_MAX = 0xdfff

function isHighSurrogate(v: number): boolean {
    return v >= SURROGATE_HIGH_MIN && v <= SURROGATE_HIGH_MAX
}

function isLowSurrogate(v: number): boolean {
    return v >= SURROGATE_LOW_MIN && v <= SURROGATE_LOW_MAX
}

// ─── Character width (lightweight, no external dep) ───────────────────────

/**
 * Returns the display width of a character in a terminal.
 * CJK ideographs and fullwidth forms → 2, control chars → 0, others → 1.
 */
function charWidth(char: string): number {
    const cp = char.codePointAt(0)
    if (cp === undefined) return 0
    if (cp < 0x20) return 0 // control chars
    // CJK Unified Ideographs, CJK Extension A/B, CJK Compatibility
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

// ─── Cursor boundary helpers ──────────────────────────────────────────────

export function clampCursorToBoundary(value: string, cursor: number): number {
    if (!Number.isFinite(cursor)) return 0
    if (cursor <= 0) return 0
    if (cursor >= value.length) return value.length
    if (value.length === 0) return 0

    const normalized = Math.floor(cursor)
    if (normalized <= 0) return 0
    if (normalized >= value.length) return value.length

    const current = value.charCodeAt(normalized)
    const previous = value.charCodeAt(normalized - 1)

    if (isLowSurrogate(current) && isHighSurrogate(previous)) {
        return normalized - 1
    }

    return normalized
}

export function nextCursorIndex(value: string, cursor: number): number {
    const safe = clampCursorToBoundary(value, cursor)
    if (safe >= value.length) return value.length
    const cp = value.codePointAt(safe)
    if (cp === undefined) return Math.min(value.length, safe + 1)
    return Math.min(value.length, safe + (cp > 0xffff ? 2 : 1))
}

export function previousCursorIndex(value: string, cursor: number): number {
    const safe = clampCursorToBoundary(value, cursor)
    if (safe <= 0) return 0
    const prev = safe - 1
    if (prev <= 0) return prev
    const currentCode = value.charCodeAt(prev)
    const beforeCode = value.charCodeAt(prev - 1)
    if (isLowSurrogate(currentCode) && isHighSurrogate(beforeCode)) {
        return prev - 1
    }
    return prev
}

// ─── Cursor movement ──────────────────────────────────────────────────────

export function moveCursorLeft(value: string, cursor: number): number {
    return previousCursorIndex(value, cursor)
}

export function moveCursorRight(value: string, cursor: number): number {
    return nextCursorIndex(value, cursor)
}

// ─── Editor operations ────────────────────────────────────────────────────

export function insertAtCursor(
    value: string,
    cursor: number,
    input: string,
): EditorBuffer {
    const safe = clampCursorToBoundary(value, cursor)
    if (!input) return { value, cursor: safe }

    // Normalize pasted line endings: \r\n → \n, lone \r → \n
    const normalized = input.replace(/\r\n?/g, '\n')
    if (!normalized) return { value, cursor: safe }

    const next = `${value.slice(0, safe)}${normalized}${value.slice(safe)}`
    return { value: next, cursor: safe + normalized.length }
}

export function backspaceAtCursor(
    value: string,
    cursor: number,
): EditorBuffer {
    const safe = clampCursorToBoundary(value, cursor)
    if (safe <= 0) return { value, cursor: safe }
    const start = previousCursorIndex(value, safe)
    const next = `${value.slice(0, start)}${value.slice(safe)}`
    return { value: next, cursor: start }
}

// ─── Wrapped cursor layout ────────────────────────────────────────────────

export function getWrappedCursorLayout(
    value: string,
    cursor: number,
    columns: number,
): WrappedCursorLayout {
    const safe = clampCursorToBoundary(value, cursor)
    const wrapCols = Number.isFinite(columns)
        ? Math.max(1, Math.floor(columns))
        : 1

    const lines: WrappedCursorLine[] = []
    let segStart = 0
    let segEnd = 0
    let segText = ''
    let segWidth = 0

    const pushSeg = () => {
        lines.push({ text: segText, start: segStart, end: segEnd })
    }

    let index = 0
    for (const char of value) {
        const charStart = index
        index += char.length

        if (char === '\n') {
            segEnd = charStart
            pushSeg()
            segStart = index
            segEnd = index
            segText = ''
            segWidth = 0
            continue
        }

        const cw = Math.max(0, charWidth(char))
        if (segText.length > 0 && segWidth + cw > wrapCols) {
            pushSeg()
            segStart = charStart
            segEnd = charStart
            segText = ''
            segWidth = 0
        }

        segText += char
        segEnd = index
        segWidth += cw
    }
    pushSeg()

    if (lines.length === 0) {
        return {
            lines: [{ text: '', start: 0, end: 0 }],
            row: 0,
            cursorInRow: 0,
        }
    }

    let row = Math.max(0, lines.length - 1)
    let cursorInRow = (lines[row]?.text ?? '').length

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line) continue
        if (safe < line.start) continue
        if (safe <= line.end) {
            row = i
            cursorInRow = safe - line.start
            break
        }
    }

    return { lines, row, cursorInRow }
}
