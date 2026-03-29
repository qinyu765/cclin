/**
 * @file Unit tests for Hooks system (Phase 7).
 *
 * Tests: buildHookRunners, runHook, snapshotHistory
 */

import { describe, it, expect, vi } from 'vitest'
import {
    buildHookRunners,
    runHook,
    snapshotHistory,
} from './hooks.js'
import type { ChatMessage } from '../types.js'

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runHook', () => {
    it('should execute handlers successfully', async () => {
        const h1 = vi.fn(async () => undefined)
        const h2 = vi.fn(async () => undefined)

        await runHook({ onTurnStart: [h1, h2] } as any, 'onTurnStart', { history: [] } as any)

        expect(h1).toHaveBeenCalledOnce()
        expect(h2).toHaveBeenCalledOnce()
    })

    it('should isolate errors and continue sequence', async () => {
        const h1 = vi.fn(async () => { throw new Error('First failed') })
        const h2 = vi.fn(async () => undefined)

        // Console.error will be called, hide it to avoid noisy test output
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

        await runHook({ onTurnStart: [h1, h2] } as any, 'onTurnStart', { history: [] } as any)

        expect(h1).toHaveBeenCalledOnce()
        expect(h2).toHaveBeenCalledOnce() // h2 still runs despite h1 error

        spy.mockRestore()
    })
})

describe('buildHookRunners', () => {
    it('should merge app hooks and middleware correctly', () => {
        const globalHook: any = {
            onTurnStart: vi.fn(),
        }

        const middleware: any = {
            name: 'test-mid',
            onTurnStart: vi.fn(),
        }

        const runners = buildHookRunners(globalHook, [middleware])

        expect(runners).toBeDefined()
        expect(runners.onTurnStart).toHaveLength(2)
    })
})

describe('snapshotHistory', () => {
    it('should perform deep copy of message history', () => {
        const original: ChatMessage[] = [
            { role: 'user', content: 'hello' },
            {
                role: 'assistant',
                content: 'hi',
                tool_calls: [{
                    id: '1', type: 'function', function: { name: 'f', arguments: '{}' }
                }]
            },
        ]

        const snapshot = snapshotHistory(original)

        // It should match structure
        expect(snapshot).toEqual(original)

        // But be a different reference at the top level
        expect(snapshot).not.toBe(original)

        // And different reference at the tool calls level
        const originalAsst = original[1] as any
        const snapshotAsst = snapshot[1] as any
        expect(snapshotAsst.tool_calls).not.toBe(originalAsst.tool_calls)

        // Modifying original shouldn't affect snapshot
        original.push({ role: 'user', content: 'mutated' })
        expect(snapshot).toHaveLength(2)
        
        // Modifying deep object doesn't affect snapshot
        if (originalAsst.tool_calls) {
            originalAsst.tool_calls[0].function.arguments = '{"mutated":true}'
        }
        
        expect(snapshotAsst.tool_calls?.[0].function.arguments).toBe('{}')
    })
})
