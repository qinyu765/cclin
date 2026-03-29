/**
 * @file Unit tests for context compaction module (Phase 6).
 *
 * Tests: isContextSummaryMessage, buildCompactionUserPrompt, buildCompactedHistory
 */

import { describe, it, expect } from 'vitest'
import {
    isContextSummaryMessage,
    buildCompactionUserPrompt,
    buildCompactedHistory,
} from './compaction.js'
import type { ChatMessage } from '../types.js'

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function msg(
    role: 'user' | 'assistant' | 'system',
    content: string,
): ChatMessage {
    return { role, content }
}

function summaryMsg(text: string): ChatMessage {
    return {
        role: 'user',
        content: `Another language model started to solve this problem and produced a summary of its thinking process. Use this summary to continue the task without redoing completed work.\n${text}`,
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('isContextSummaryMessage', () => {
    it('should identify summary messages', () => {
        expect(isContextSummaryMessage(summaryMsg('stuff'))).toBe(true)
    })

    it('should reject non-summary user messages', () => {
        expect(isContextSummaryMessage(msg('user', 'hello'))).toBe(false)
    })

    it('should reject assistant messages', () => {
        expect(isContextSummaryMessage(msg('assistant', 'sup'))).toBe(false)
    })
})

describe('buildCompactionUserPrompt', () => {
    it('should format message transcript correctly', () => {
        const history: ChatMessage[] = [
            msg('user', 'What is 1+1?'),
            msg('assistant', '2'),
            msg('user', 'wrong'),
        ]

        const prompt = buildCompactionUserPrompt(history)
        
        expect(prompt).toContain('[0] USER\nWhat is 1+1?')
        expect(prompt).toContain('[1] ASSISTANT\n2')
        expect(prompt).toContain('[2] USER\nwrong')
    })
})

describe('buildCompactedHistory', () => {
    it('should merge summary and retain system message', () => {
        const history: ChatMessage[] = [
            msg('system', 'sys prompt here'),
            msg('user', 'hi'),
            msg('assistant', 'hello'),
            msg('user', 'do it'),
        ]

        const compacted = buildCompactedHistory(history[0], 'New Summary')

        expect(compacted).toHaveLength(2)
        expect(compacted[0].role).toBe('system')
        expect(compacted[0].content).toBe('sys prompt here')
        
        expect(compacted[1].role).toBe('user')
        expect(compacted[1].content).toContain('Another language model started')
        expect(compacted[1].content).toContain('New Summary')
    })

    it('should work without system message', () => {
        const history: ChatMessage[] = [
            msg('user', 'hi'),
            msg('assistant', 'hello'),
        ]

        const compacted = buildCompactedHistory(undefined, 'Summary Only')

        expect(compacted).toHaveLength(1)
        expect(compacted[0].role).toBe('user')
        expect(compacted[0].content).toContain('Summary Only')
    })
})
