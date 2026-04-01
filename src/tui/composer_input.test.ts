import { describe, it, expect } from 'vitest'
import {
    clampCursorToBoundary,
    moveCursorLeft,
    moveCursorRight,
    insertAtCursor,
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
