/**
 * @file Unit tests for ReAct Loop Parsing (Phase 2).
 *
 * Tests: parseLLMResponse, normalizeLLMResponse
 */

import { describe, it, expect } from 'vitest'
import {
    parseLLMResponse,
    normalizeLLMResponse,
} from './react-loop.js'
import type { LLMResponse } from '../types.js'

describe('parseLLMResponse', () => {
    it('should return direct answer for pure text response', () => {
        const parsed = parseLLMResponse('Here is the answer.', [])
        expect(parsed.final).toBe('Here is the answer.')
        expect(parsed.action).toBeUndefined()
    })

    it('should parse simple tool calls', () => {
        const parsed = parseLLMResponse('', [
            { id: 'call_1', name: 'bash', input: { command: 'ls' } },
        ])
        expect(parsed.action).toBeDefined()
        expect(parsed.action?.tool).toBe('bash')
        expect(parsed.action?.input).toEqual({ command: 'ls' })
        expect(parsed.thinking).toBeUndefined()
    })

    it('should extract thought text when both text and tools are present', () => {
        const parsed = parseLLMResponse('I should run ls.', [
            { id: 'call_1', name: 'bash', input: { command: 'ls' } },
        ])
        expect(parsed.action).toBeDefined()
        expect(parsed.thinking).toBe('I should run ls.')
    })

    it('should handle multiple tool calls', () => {
        const parsed = parseLLMResponse('Running two commands.', [
            { id: 'c1', name: 'bash', input: { command: 'ls' } },
            { id: 'c2', name: 'bash', input: { command: 'pwd' } },
        ])
        expect(parsed.action).toBeDefined()
        expect(parsed.actions).toHaveLength(2)
        expect(parsed.action?.tool).toBe('bash')
    })

    it('should handle empty input safely', () => {
        const parsed = parseLLMResponse('', [])
        expect(parsed.final).toBeUndefined()
        expect(parsed.action).toBeUndefined()
    })
})

describe('normalizeLLMResponse', () => {
    it('should split ContentBlocks into text and tools', () => {
        const response: LLMResponse = {
            stop_reason: 'tool_use',
            content: [
                { type: 'text', text: 'hi\n' },
                { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
                { type: 'text', text: 'more text' },
            ],
            usage: { prompt: 10, completion: 5, total: 15 },
        }

        const normalized = normalizeLLMResponse(response)

        expect(normalized.textContent).toBe('hi\nmore text')
        expect(normalized.toolUseBlocks).toHaveLength(1)
        expect(normalized.toolUseBlocks[0].id).toBe('t1')
        expect(normalized.toolUseBlocks[0].name).toBe('bash')
        expect(normalized.toolUseBlocks[0].input).toEqual({ command: 'ls' })
        expect(normalized.stopReason).toBe('tool_use')
        expect(normalized.usage?.prompt).toBe(10)
    })

    it('should handle pure text', () => {
        const response: LLMResponse = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'just text' }] }
        const normalized = normalizeLLMResponse(response)
        expect(normalized.textContent).toBe('just text')
        expect(normalized.toolUseBlocks).toHaveLength(0)
    })

    it('should handle only tool calls', () => {
        const response: LLMResponse = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] }
        const normalized = normalizeLLMResponse(response)
        expect(normalized.textContent).toBe('')
        expect(normalized.toolUseBlocks).toHaveLength(1)
    })
})
