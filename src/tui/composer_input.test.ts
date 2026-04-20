import { describe, it, expect } from 'vitest'
import {
    clampCursorToBoundary,
    moveCursorLeft,
    moveCursorRight,
    moveCursorUp,
    moveCursorDown,
    insertAtCursor,
    insertNewline,
    deleteToLineStart,
    backspaceAtCursor,
    getWrappedCursorLayout,
} from './composer_input.js'

describe('clampCursorToBoundary', () => {
    it('clamps negative to 0', () => {
        expect(clampCursorToBoundary('abc', -1)).toBe(0)
    })
    it('clamps beyond length', () => {
        expect(clampCursorToBoundary('abc', 10)).toBe(3)
    })
    it('returns 0 for empty string', () => {
        expect(clampCursorToBoundary('', 5)).toBe(0)
    })
    it('adjusts cursor inside surrogate pair', () => {
        const s = '😀abc' // 😀 = 2 code units
        // cursor at 1 is inside the surrogate pair
        expect(clampCursorToBoundary(s, 1)).toBe(0)
    })
})

describe('moveCursorLeft / moveCursorRight', () => {
    it('left from 0 stays 0', () => {
        expect(moveCursorLeft('abc', 0)).toBe(0)
    })
    it('right from end stays at end', () => {
        expect(moveCursorRight('abc', 3)).toBe(3)
    })
    it('moves across surrogate pair', () => {
        const s = '😀x'
        expect(moveCursorRight(s, 0)).toBe(2) // skip both code units
        expect(moveCursorLeft(s, 2)).toBe(0)
    })
})

describe('insertAtCursor', () => {
    it('inserts at cursor position', () => {
        const r = insertAtCursor('ac', 1, 'b')
        expect(r.value).toBe('abc')
        expect(r.cursor).toBe(2)
    })
    it('normalizes CRLF to LF', () => {
        const r = insertAtCursor('', 0, 'a\r\nb')
        expect(r.value).toBe('a\nb')
        expect(r.cursor).toBe(3)
    })
})

describe('backspaceAtCursor', () => {
    it('does nothing at position 0', () => {
        const r = backspaceAtCursor('abc', 0)
        expect(r.value).toBe('abc')
        expect(r.cursor).toBe(0)
    })
    it('deletes character before cursor', () => {
        const r = backspaceAtCursor('abc', 2)
        expect(r.value).toBe('ac')
        expect(r.cursor).toBe(1)
    })
})

describe('getWrappedCursorLayout', () => {
    it('single line within columns', () => {
        const layout = getWrappedCursorLayout('hello', 3, 80)
        expect(layout.lines).toHaveLength(1)
        expect(layout.row).toBe(0)
        expect(layout.cursorInRow).toBe(3)
    })

    it('wraps long text at column boundary', () => {
        const layout = getWrappedCursorLayout('abcdef', 4, 3)
        // "abc" | "def"
        expect(layout.lines).toHaveLength(2)
        expect(layout.lines[0]!.text).toBe('abc')
        expect(layout.lines[1]!.text).toBe('def')
        expect(layout.row).toBe(1)
        expect(layout.cursorInRow).toBe(1)
    })

    it('handles newline-separated lines', () => {
        const layout = getWrappedCursorLayout('abc\ndef', 5, 80)
        expect(layout.lines).toHaveLength(2)
        expect(layout.lines[0]!.text).toBe('abc')
        expect(layout.lines[1]!.text).toBe('def')
        expect(layout.row).toBe(1)
        expect(layout.cursorInRow).toBe(1)
    })

    it('empty string', () => {
        const layout = getWrappedCursorLayout('', 0, 80)
        expect(layout.lines).toHaveLength(1)
        expect(layout.row).toBe(0)
        expect(layout.cursorInRow).toBe(0)
    })
})

describe('moveCursorUp', () => {
    it('moves from second line to first line', () => {
        // "abc\ndef", cursor at 'd' (index 4), columns=80
        const result = moveCursorUp('abc\ndef', 4, 80)
        expect(result).toBe(0) // beginning of first row (col 0 on row 0)
    })
    it('on first row goes to position 0', () => {
        expect(moveCursorUp('hello', 3, 80)).toBe(0)
    })
    it('preserves column offset when moving up', () => {
        // "abcde\nfgh", cursor at 'g' (index 7, col 1 on row 1)
        const result = moveCursorUp('abcde\nfgh', 7, 80)
        expect(result).toBe(1) // col 1 on row 0 = index 1
    })
    it('clamps column when upper line is shorter', () => {
        // "ab\ndefgh", cursor at 'h' (index 8, col 4 on row 1)
        const result = moveCursorUp('ab\ndefgh', 8, 80)
        expect(result).toBe(2) // clamped to end of "ab" = index 2
    })
})

describe('moveCursorDown', () => {
    it('moves from first line to second line', () => {
        // "abc\ndef", cursor at 'a' (index 0), columns=80
        const result = moveCursorDown('abc\ndef', 0, 80)
        expect(result).toBe(4) // col 0 on row 1 = index 4
    })
    it('on last row goes to end', () => {
        expect(moveCursorDown('hello', 2, 80)).toBe(5)
    })
    it('preserves column offset when moving down', () => {
        // "abcde\nfgh", cursor at 'b' (index 1, col 1 on row 0)
        const result = moveCursorDown('abcde\nfgh', 1, 80)
        expect(result).toBe(7) // col 1 on row 1 = index 7
    })
})

describe('insertNewline', () => {
    it('inserts newline at cursor', () => {
        const r = insertNewline('abc', 1)
        expect(r.value).toBe('a\nbc')
        expect(r.cursor).toBe(2)
    })
    it('inserts at start', () => {
        const r = insertNewline('abc', 0)
        expect(r.value).toBe('\nabc')
        expect(r.cursor).toBe(1)
    })
    it('inserts at end', () => {
        const r = insertNewline('abc', 3)
        expect(r.value).toBe('abc\n')
        expect(r.cursor).toBe(4)
    })
})

describe('deleteToLineStart', () => {
    it('deletes from cursor to line start on single line', () => {
        const r = deleteToLineStart('hello', 3)
        expect(r.value).toBe('lo')
        expect(r.cursor).toBe(0)
    })
    it('deletes within second line only', () => {
        // "abc\ndef", cursor at 'f' (index 6)
        const r = deleteToLineStart('abc\ndef', 6)
        expect(r.value).toBe('abc\nf')
        expect(r.cursor).toBe(4) // start of second line
    })
    it('at line start joins with previous line', () => {
        // "abc\ndef", cursor at 'd' (index 4, start of line 2)
        const r = deleteToLineStart('abc\ndef', 4)
        expect(r.value).toBe('abcdef')
        expect(r.cursor).toBe(3) // was at \n position
    })
    it('does nothing at position 0', () => {
        const r = deleteToLineStart('abc', 0)
        expect(r.value).toBe('abc')
        expect(r.cursor).toBe(0)
    })
})
