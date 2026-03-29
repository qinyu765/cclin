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
