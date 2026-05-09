/**
 * @file Unit tests for ReAct Loop Parsing (Phase 2).
 *
 * Tests: parseLLMResponse, normalizeLLMResponse
 */

import { describe, it, expect, vi } from 'vitest'
import {
    parseLLMResponse,
    normalizeLLMResponse,
    runTurn,
} from './react-loop.js'
import type { ChatMessage, LLMResponse, ToolAction } from '../types.js'

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

describe('runTurn tool execution', () => {
    it('should execute multiple tool calls through executeTools once', async () => {
        const history: ChatMessage[] = []
        const callLLM = vi.fn(async (): Promise<LLMResponse> => {
            if (callLLM.mock.calls.length === 1) {
                return {
                    stop_reason: 'tool_use',
                    content: [
                        { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
                        { type: 'tool_use', id: 'c2', name: 'list_directory', input: { path: '.' } },
                    ],
                }
            }
            return {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'done' }],
            }
        })
        const executeTools = vi.fn(async (actions: ToolAction[]) => ({
            results: actions.map((action) => ({
                actionId: action.id,
                tool: action.name,
                status: 'success' as const,
                success: true,
                observation: `ok:${action.name}`,
                durationMs: 1,
            })),
            combinedObservation: 'ok:read_file\n---\nok:list_directory',
            hasRejection: false,
        }))

        const result = await runTurn('inspect', {
            history,
            callLLM,
            executeTools,
        })

        expect(result.finalText).toBe('done')
        expect(executeTools).toHaveBeenCalledOnce()
        expect(executeTools.mock.calls[0]?.[0]).toEqual([
            { id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
            { id: 'c2', name: 'list_directory', input: { path: '.' } },
        ])
        const toolMessages = history.filter((msg) => msg.role === 'tool')
        expect(toolMessages).toHaveLength(2)
        expect(toolMessages.map((msg) => msg.tool_call_id)).toEqual(['c1', 'c2'])
    })

    it('should add skipped observations for tool calls not returned after rejection', async () => {
        const history: ChatMessage[] = []
        const callLLM = vi.fn(async (messages: ChatMessage[]): Promise<LLMResponse> => {
            if (callLLM.mock.calls.length === 1) {
                return {
                    stop_reason: 'tool_use',
                    content: [
                        { type: 'tool_use', id: 'c1', name: 'write_file', input: { path: 'a.ts', content: '' } },
                        { type: 'tool_use', id: 'c2', name: 'read_file', input: { path: 'a.ts' } },
                    ],
                }
            }

            const toolMessages = messages.filter((msg) => msg.role === 'tool')
            expect(toolMessages).toHaveLength(2)
            expect(toolMessages[0]?.tool_call_id).toBe('c1')
            expect(toolMessages[1]?.tool_call_id).toBe('c2')
            expect(toolMessages[1]?.content).toContain('Skipped')
            return {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'denied handled' }],
            }
        })
        const executeTools = vi.fn(async () => ({
            results: [{
                actionId: 'c1',
                tool: 'write_file',
                status: 'approval_denied' as const,
                success: false,
                observation: 'User denied: "write_file".',
                durationMs: 1,
            }],
            combinedObservation: 'User denied: "write_file".',
            hasRejection: true,
        }))

        const result = await runTurn('edit', {
            history,
            callLLM,
            executeTools,
        })

        expect(result.finalText).toBe('denied handled')
        expect(executeTools).toHaveBeenCalledOnce()
    })

    it('should fall back to executeTool when executeTools is not provided', async () => {
        const history: ChatMessage[] = []
        const callLLM = vi.fn(async (): Promise<LLMResponse> => {
            if (callLLM.mock.calls.length === 1) {
                return {
                    stop_reason: 'tool_use',
                    content: [
                        { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
                        { type: 'tool_use', id: 'c2', name: 'list_directory', input: { path: '.' } },
                    ],
                }
            }
            return {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'done' }],
            }
        })
        const executeTool = vi.fn(async (name: string) => `ok:${name}`)

        await runTurn('inspect', {
            history,
            callLLM,
            executeTool,
        })

        expect(executeTool).toHaveBeenCalledTimes(2)
        expect(executeTool.mock.calls.map((call) => call[0])).toEqual([
            'read_file',
            'list_directory',
        ])
    })
})
