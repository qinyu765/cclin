/**
 * @file Unit tests for ToolOrchestrator (Phase 4).
 *
 * Tests: tool not found, approval denied, successful execution,
 *        output truncation, parseToolInput, createExecuteTool
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolOrchestrator } from './orchestrator.js'
import { ApprovalManager } from './approval.js'
import type { ToolDefinition, ToolAction, ToolQueryable } from '../types.js'

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function makeTool(
    name: string,
    mutating: boolean,
    output = 'ok',
): ToolDefinition {
    return {
        name,
        description: `${name} desc`,
        inputSchema: { type: 'object', properties: {}, required: [] },
        isMutating: mutating,
        execute: vi.fn(async () => ({ output })),
    }
}

function makeRegistry(tools: ToolDefinition[]): ToolQueryable {
    const map = new Map(tools.map((t) => [t.name, t]))
    return { get: (name: string) => map.get(name) }
}

function makeAction(name: string, input: unknown = {}): ToolAction {
    return { id: `${name}:1`, name, input }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
        resolve = r
    })
    return { promise, resolve }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ToolOrchestrator', () => {
    let approval: ApprovalManager
    let orchestrator: ToolOrchestrator

    describe('executeAction', () => {
        beforeEach(() => {
            approval = new ApprovalManager()
        })

        it('should return tool_not_found for unknown tools', async () => {
            orchestrator = new ToolOrchestrator(makeRegistry([]), approval)
            const result = await orchestrator.executeAction(makeAction('x'))
            expect(result.status).toBe('tool_not_found')
            expect(result.success).toBe(false)
        })

        it('should deny when no approval hook and tool is mutating', async () => {
            const tool = makeTool('bash', true)
            orchestrator = new ToolOrchestrator(makeRegistry([tool]), approval)
            const result = await orchestrator.executeAction(makeAction('bash'))
            expect(result.status).toBe('approval_denied')
            expect(result.success).toBe(false)
        })

        it('should auto-pass non-mutating tools', async () => {
            const tool = makeTool('read_file', false, 'file content')
            orchestrator = new ToolOrchestrator(makeRegistry([tool]), approval)
            const result = await orchestrator.executeAction(makeAction('read_file'))
            expect(result.status).toBe('success')
            expect(result.observation).toBe('file content')
        })

        it('should pass with approval hook returning approve', async () => {
            const tool = makeTool('bash', true, 'done')
            orchestrator = new ToolOrchestrator(makeRegistry([tool]), approval)
            const hooks = { requestApproval: vi.fn(async () => 'approve' as const) }
            const result = await orchestrator.executeAction(makeAction('bash'), hooks)
            expect(result.status).toBe('success')
            expect(result.observation).toBe('done')
        })

        it('should handle tool execution error', async () => {
            const tool = makeTool('bad', false)
            vi.mocked(tool.execute).mockRejectedValue(new Error('boom'))
            orchestrator = new ToolOrchestrator(makeRegistry([tool]), approval)
            const result = await orchestrator.executeAction(makeAction('bad'))
            expect(result.status).toBe('execution_failed')
            expect(result.observation).toContain('boom')
        })

        it('should truncate oversized output', async () => {
            const big = 'x'.repeat(60_000)
            const tool = makeTool('big_tool', false, big)
            orchestrator = new ToolOrchestrator(makeRegistry([tool]), approval)
            const result = await orchestrator.executeAction(makeAction('big_tool'))
            expect(result.observation.length).toBeLessThan(big.length)
            expect(result.observation).toContain('[truncated]')
        })
    })

    describe('executeActions', () => {
        it('should run read-only safe tools in parallel', async () => {
            approval = new ApprovalManager({ policy: 'auto' })
            const gate = deferred()
            const started: string[] = []
            const readFile = makeTool('read_file', false)
            const listDirectory = makeTool('list_directory', false)
            vi.mocked(readFile.execute).mockImplementation(async () => {
                started.push('read_file')
                await gate.promise
                return { output: 'read' }
            })
            vi.mocked(listDirectory.execute).mockImplementation(async () => {
                started.push('list_directory')
                return { output: 'list' }
            })
            orchestrator = new ToolOrchestrator(
                makeRegistry([readFile, listDirectory]),
                approval,
            )

            const pending = orchestrator.executeActions([
                makeAction('read_file'),
                makeAction('list_directory'),
            ])
            await Promise.resolve()

            expect(started).toEqual(['read_file', 'list_directory'])
            gate.resolve()
            const result = await pending
            expect(result.results).toHaveLength(2)
        })

        it('should keep mutating tools serial', async () => {
            approval = new ApprovalManager({ policy: 'auto' })
            const gate = deferred()
            const started: string[] = []
            const first = makeTool('write_file', true)
            const second = makeTool('edit_file', true)
            vi.mocked(first.execute).mockImplementation(async () => {
                started.push('write_file')
                await gate.promise
                return { output: 'written' }
            })
            vi.mocked(second.execute).mockImplementation(async () => {
                started.push('edit_file')
                return { output: 'edited' }
            })
            orchestrator = new ToolOrchestrator(
                makeRegistry([first, second]),
                approval,
            )

            const pending = orchestrator.executeActions([
                makeAction('write_file'),
                makeAction('edit_file'),
            ])
            await Promise.resolve()

            expect(started).toEqual(['write_file'])
            gate.resolve()
            await pending
            expect(started).toEqual(['write_file', 'edit_file'])
        })

        it('should keep sub-agent lifecycle tools serial', async () => {
            approval = new ApprovalManager({ policy: 'auto' })
            const gate = deferred()
            const started: string[] = []
            const spawn = makeTool('spawn_agent', false)
            const send = makeTool('send_input', false)
            vi.mocked(spawn.execute).mockImplementation(async () => {
                started.push('spawn_agent')
                await gate.promise
                return { output: 'spawned' }
            })
            vi.mocked(send.execute).mockImplementation(async () => {
                started.push('send_input')
                return { output: 'sent' }
            })
            orchestrator = new ToolOrchestrator(
                makeRegistry([spawn, send]),
                approval,
            )

            const pending = orchestrator.executeActions([
                makeAction('spawn_agent'),
                makeAction('send_input'),
            ])
            await Promise.resolve()

            expect(started).toEqual(['spawn_agent'])
            gate.resolve()
            await pending
            expect(started).toEqual(['spawn_agent', 'send_input'])
        })

        it('should stop on first approval_denied', async () => {
            approval = new ApprovalManager()
            const t1 = makeTool('a', true)
            const t2 = makeTool('b', true)
            orchestrator = new ToolOrchestrator(makeRegistry([t1, t2]), approval)
            const result = await orchestrator.executeActions([
                makeAction('a'),
                makeAction('b'),
            ])
            expect(result.hasRejection).toBe(true)
            // Only first was attempted
            expect(result.results).toHaveLength(1)
        })
    })

    describe('createExecuteTool', () => {
        it('should return observation string', async () => {
            approval = new ApprovalManager()
            const tool = makeTool('list', false, 'files here')
            orchestrator = new ToolOrchestrator(makeRegistry([tool]), approval)
            const exec = orchestrator.createExecuteTool()
            const obs = await exec('list', {})
            expect(obs).toBe('files here')
        })
    })

    describe('createExecuteTools', () => {
        it('should return batch execution result', async () => {
            approval = new ApprovalManager()
            const tool = makeTool('list_directory', false, 'files here')
            orchestrator = new ToolOrchestrator(makeRegistry([tool]), approval)
            const exec = orchestrator.createExecuteTools()
            const result = await exec([makeAction('list_directory')])
            expect(result.results).toHaveLength(1)
            expect(result.combinedObservation).toBe('files here')
        })
    })

    describe('lifecycle', () => {
        it('clearOnceApprovals delegates to approval manager', () => {
            approval = new ApprovalManager()
            const spy = vi.spyOn(approval, 'clearOnceApprovals')
            orchestrator = new ToolOrchestrator(makeRegistry([]), approval)
            orchestrator.clearOnceApprovals()
            expect(spy).toHaveBeenCalledOnce()
        })

        it('dispose delegates to approval manager', () => {
            approval = new ApprovalManager()
            const spy = vi.spyOn(approval, 'dispose')
            orchestrator = new ToolOrchestrator(makeRegistry([]), approval)
            orchestrator.dispose()
            expect(spy).toHaveBeenCalledOnce()
        })
    })
})
