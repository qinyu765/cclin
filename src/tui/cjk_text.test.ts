import { describe, it, expect } from 'vitest'
import { charWidth, stringWidth, wrapTextCJK } from './cjk_text.js'

describe('charWidth', () => {
    it('returns 1 for ASCII', () => {
        expect(charWidth('a')).toBe(1)
        expect(charWidth('Z')).toBe(1)
        expect(charWidth('!')).toBe(1)
    })
    it('returns 2 for CJK ideographs', () => {
        expect(charWidth('中')).toBe(2)
        expect(charWidth('可')).toBe(2)
        expect(charWidth('你')).toBe(2)
    })
    it('returns 2 for fullwidth forms', () => {
        expect(charWidth('Ａ')).toBe(2) // U+FF21
    })
    it('returns 0 for control chars', () => {
        expect(charWidth('\t')).toBe(0)
        expect(charWidth('\x00')).toBe(0)
    })
})

describe('stringWidth', () => {
    it('counts ASCII correctly', () => {
        expect(stringWidth('hello')).toBe(5)
    })
    it('counts CJK correctly', () => {
        expect(stringWidth('你好')).toBe(4)
    })
    it('counts mixed text correctly', () => {
        expect(stringWidth('hi你好')).toBe(6)
    })
})

describe('wrapTextCJK', () => {
    it('no wrapping needed for short ASCII', () => {
        expect(wrapTextCJK('hello', 80)).toEqual(['hello'])
    })

    it('wraps ASCII at column boundary', () => {
        expect(wrapTextCJK('abcdef', 3)).toEqual(['abc', 'def'])
    })

    it('wraps CJK text respecting double width', () => {
        // 3 CJK chars = 6 cells. columns=5 → first line fits 2 chars (4 cells), 3rd on next
        expect(wrapTextCJK('你好吗', 5)).toEqual(['你好', '吗'])
    })

    it('prevents CJK char from overflowing', () => {
        // "abc" = 3 cells, "可" = 2 cells. columns=4 → "abc" fits, "可" doesn't (3+2=5>4), wraps
        expect(wrapTextCJK('abc可', 4)).toEqual(['abc', '可'])
    })

    it('handles mixed ASCII and CJK', () => {
        // "hi你" = 2+2=4 cells, "好" = 2 cells. columns=5 → "hi你" fits (4), "好" fits too (4+2=6>5)
        expect(wrapTextCJK('hi你好', 5)).toEqual(['hi你', '好'])
    })

    it('preserves explicit newlines', () => {
        expect(wrapTextCJK('a\nb', 80)).toEqual(['a', 'b'])
    })

    it('handles empty lines from newlines', () => {
        expect(wrapTextCJK('a\n\nb', 80)).toEqual(['a', '', 'b'])
    })

    it('handles empty string', () => {
        expect(wrapTextCJK('', 80)).toEqual([''])
    })
})
