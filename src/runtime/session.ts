/**
 * @file Session 类 — 管理多轮对话状态。
 *
 * Phase 2：持有对话历史和 LLM 调用函数，
 * 委托 `runTurn()` 执行 ReAct 循环。
 *
 * Session 只做状态管理，不包含循环逻辑，
 * 这样循环可独立测试，Session 也容易扩展。
 */

import { randomUUID } from 'node:crypto'
import { runTurn } from './react-loop.js'
import type { CallLLM, ChatMessage, TurnResult, ExecuteTool } from '../types.js'

// ─── Session 配置 ──────────────────────────────────────────────────────────────

/** Session 构造参数。 */
export type SessionOptions = {
    /** LLM 调用函数（必选）。 */
    callLLM: CallLLM
    /** 系统提示词（可选）。 */
    systemPrompt?: string
    /** 工具执行函数（可选，Phase 2 默认 mock）。 */
    executeTool?: ExecuteTool
    /** 自定义 Session ID（默认随机 UUID）。 */
    sessionId?: string
}

// ─── Session 类 ──────────────────────────────────────────────────────────────

/**
 * Agent Session 类。
 *
 * 用法：
 * ```ts
 * const session = new Session({ callLLM, systemPrompt: '...' })
 * const result = await session.runTurn('你好')
 * console.log(result.finalText)
 * ```
 */
export class Session {
    /** Session 唯一标识。 */
    readonly id: string

    /** 对话历史。 */
    readonly history: ChatMessage[] = []

    /** 轮次计数器。 */
    private turnIndex = 0

    /** LLM 调用函数。 */
    private readonly callLLM: CallLLM

    /** 工具执行函数。 */
    private readonly executeTool?: ExecuteTool

    constructor(options: SessionOptions) {
        this.id = options.sessionId ?? randomUUID()
        this.callLLM = options.callLLM
        this.executeTool = options.executeTool

        // 如果提供了系统提示词，作为历史的第一条消息
        if (options.systemPrompt) {
            this.history.push({
                role: 'system',
                content: options.systemPrompt,
            })
        }
    }

    /**
     * 执行一轮对话。
     *
     * 委托给 react-loop.ts 的 runTurn()，传入当前 history。
     * history 会被 runTurn() 就地修改（追加用户/助手/工具消息）。
     */
    async runTurn(input: string): Promise<TurnResult> {
        this.turnIndex += 1
        console.log(`\n── Turn ${this.turnIndex} ──`)

        const result = await runTurn(input, {
            history: this.history,
            callLLM: this.callLLM,
            executeTool: this.executeTool,
        })

        return result
    }

    /** 返回当前对话历史的副本。 */
    getHistory(): ChatMessage[] {
        return [...this.history]
    }

    /** 获取当前轮次数。 */
    getTurnIndex(): number {
        return this.turnIndex
    }
}
