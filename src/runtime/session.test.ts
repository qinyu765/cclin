/**
 * @file Session 状态管理测试。
 */

import { describe, expect, it, vi } from 'vitest'
import { Session } from './session.js'
import type { CallLLM, LLMResponse } from '../types.js'

function createCallLLM(): CallLLM {
    return vi.fn(async (): Promise<LLMResponse> => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
    }))
}

describe('Session.clearHistory', () => {
    it('有 system prompt 时只保留 system 消息', async () => {
        const session = new Session({
            callLLM: createCallLLM(),
            systemPrompt: 'system prompt',
        })

        await session.runTurn('hello')
        expect(session.getHistory()).toHaveLength(3)

        session.clearHistory()

        expect(session.getHistory()).toEqual([
            { role: 'system', content: 'system prompt' },
        ])
    })

    it('无 system prompt 时清空全部历史', async () => {
        const session = new Session({ callLLM: createCallLLM() })

        await session.runTurn('hello')
        expect(session.getHistory()).toHaveLength(2)

        session.clearHistory()

        expect(session.getHistory()).toEqual([])
    })

    it('不会重置当前轮次', async () => {
        const session = new Session({
            callLLM: createCallLLM(),
            systemPrompt: 'system prompt',
        })

        await session.runTurn('hello')
        expect(session.getTurnIndex()).toBe(1)

        session.clearHistory()

        expect(session.getTurnIndex()).toBe(1)
    })
})
