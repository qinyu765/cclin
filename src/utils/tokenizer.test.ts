/**
 * @file Unit tests for token counter (Phase 6).
 *
 * Tests: createTokenCounter (countText, countMessages)
 */

import { describe, it, expect } from 'vitest'
import { createTokenCounter } from './tokenizer.js'
import type { ChatMessage } from '../types.js'

describe('createTokenCounter', () => {
    it('should count plain text accurately', () => {
        const counter = createTokenCounter()
        const text = 'Hello, world! This is a test.'
        // gpt-tokenizer is deterministic, so we can expect a specific range or exact number
        const tokens = counter.countText(text)
        expect(tokens).toBeGreaterThan(0)
        expect(tokens).toBeLessThan(20)
    })

    it('should return 0 for empty text', () => {
        const counter = createTokenCounter()
        expect(counter.countText('')).toBe(0)
    })

    it('should count empty message array as 0', () => {
        const counter = createTokenCounter()
        expect(counter.countMessages([])).toBe(0)
    })

    it('should aggregate tokens for multiple message types', () => {
        const counter = createTokenCounter()
        const msgs: ChatMessage[] = [
            { role: 'user', content: 'test' },
            { role: 'assistant', content: 'hello' },
        ]

        const total = counter.countMessages(msgs)
        expect(total).toBeGreaterThan(0)
        // Usually content length + overhead per message
        expect(total).toBeGreaterThan(2)
        expect(total).toBeLessThan(50)
    })

    it('should count parsing of tool calls correctly', () => {
        const counter = createTokenCounter()
        const msgs: ChatMessage[] = [
            {
                role: 'assistant',
                content: 'part1',
                tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{"c":"ls"}' } }],
            },
        ]

        const total = counter.countMessages(msgs)
        // Ensure array content doesn't crash and returns a positive number
        expect(total).toBeGreaterThan(0)
    })
})
