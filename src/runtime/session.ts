/**
 * @file Session 类 — 管理多轮对话状态。
 *
 * Phase 2：持有对话历史和 LLM 调用函数，
 * 委托 `runTurn()` 执行 ReAct 循环。
 *
 * Phase 6：新增上下文压缩能力：
 *   - 接受 contextWindow / compactThreshold / tokenCounter 配置
 *   - 暴露 compactHistory() 公开方法
 *   - 将压缩相关依赖传递给 runTurn()
 */

import { randomUUID } from 'node:crypto'
import { runTurn } from './react-loop.js'
import {
    CONTEXT_COMPACTION_SYSTEM_PROMPT,
    buildCompactionUserPrompt,
    buildCompactedHistory,
} from './compaction.js'
import { buildHookRunners, runHook } from './hooks.js'
import type { HookRunnerMap } from './hooks.js'
import type {
    CallLLM,
    ChatMessage,
    TurnResult,
    ExecuteTool,
    TokenCounter,
    CompactReason,
    CompactResult,
    AgentHooks,
    AgentMiddleware,
} from '../types.js'

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
    /** Token 计数器（Phase 6，启用压缩必需）。 */
    tokenCounter?: TokenCounter
    /** 上下文窗口大小（token 数，默认 128000）。 */
    contextWindow?: number
    /** 自动压缩阈值百分比（0-100，默认 80）。 */
    compactThreshold?: number
    /** Hook 集合（Phase 7，一次性注入）。 */
    hooks?: AgentHooks
    /** 中间件列表（Phase 7，支持多个）。 */
    middlewares?: AgentMiddleware[]
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

    /** Token 计数器。 */
    private readonly tokenCounter?: TokenCounter

    /** 上下文窗口大小。 */
    private readonly contextWindow: number

    /** 自动压缩阈值百分比。 */
    private readonly compactThreshold: number

    /** Hook 注册表。 */
    private readonly hookRunners: HookRunnerMap

    constructor(options: SessionOptions) {
        this.id = options.sessionId ?? randomUUID()
        this.callLLM = options.callLLM
        this.executeTool = options.executeTool
        this.tokenCounter = options.tokenCounter
        this.contextWindow = options.contextWindow ?? 128_000
        this.compactThreshold = options.compactThreshold ?? 80
        this.hookRunners = buildHookRunners(options.hooks, options.middlewares)

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

        const result = await runTurn(input, {
            history: this.history,
            callLLM: this.callLLM,
            executeTool: this.executeTool,
            tokenCounter: this.tokenCounter,
            contextWindow: this.contextWindow,
            compactThreshold: this.compactThreshold,
            compactFn: () => this.compactHistory('auto'),
            hookRunners: this.hookRunners,
            sessionId: this.id,
            turnIndex: this.turnIndex,
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

    /**
     * 手动或自动压缩对话历史。
     *
     * 流程：
     *   1. 用 tokenCounter 计算当前 token 数
     *   2. 提取 system 消息外的历史
     *   3. 调用 LLM 生成摘要
     *   4. 用摘要重建历史
     */
    async compactHistory(
        reason: CompactReason = 'manual',
    ): Promise<CompactResult> {
        const thresholdTokens = Math.floor(
            this.contextWindow * (this.compactThreshold / 100),
        )

        // 无 tokenCounter 时跳过
        if (!this.tokenCounter) {
            return {
                reason,
                status: 'skipped',
                beforeTokens: 0,
                afterTokens: 0,
                thresholdTokens,
                reductionPercent: 0,
                errorMessage: 'No tokenCounter configured',
            }
        }

        const beforeTokens = this.tokenCounter.countMessages(this.history)
        const systemMessage =
            this.history[0]?.role === 'system' ? this.history[0] : undefined
        const historyWithoutSystem = systemMessage
            ? this.history.slice(1)
            : this.history.slice()

        // 无可压缩内容时跳过
        if (!historyWithoutSystem.length) {
            return {
                reason,
                status: 'skipped',
                beforeTokens,
                afterTokens: beforeTokens,
                thresholdTokens,
                reductionPercent: 0,
            }
        }

        try {
            // 调用 LLM 生成摘要
            const response = await this.callLLM([
                { role: 'system', content: CONTEXT_COMPACTION_SYSTEM_PROMPT },
                { role: 'user', content: buildCompactionUserPrompt(historyWithoutSystem) },
            ])

            // 提取摘要文本
            const summaryText = response.content
                .filter((b) => b.type === 'text')
                .map((b) => (b as { type: 'text'; text: string }).text)
                .join('')
                .trim()

            if (!summaryText) {
                throw new Error('Compaction model returned an empty summary.')
            }

            // 重建历史
            const compactedHistory = buildCompactedHistory(
                systemMessage,
                summaryText,
            )
            const afterTokens =
                this.tokenCounter.countMessages(compactedHistory)
            this.history.splice(
                0,
                this.history.length,
                ...compactedHistory,
            )

            const reductionPercent =
                beforeTokens > 0
                    ? Math.max(
                          0,
                          Math.round(
                              ((beforeTokens - afterTokens) / beforeTokens) *
                                  10_000,
                          ) / 100,
                      )
                    : 0

            // Phase 7：发射 onContextCompacted Hook
            await runHook(this.hookRunners, 'onContextCompacted', {
                sessionId: this.id,
                turn: this.turnIndex,
                reason,
                status: 'success',
                beforeTokens,
                afterTokens,
                thresholdTokens,
                reductionPercent,
                summary: summaryText,
            })

            return {
                reason,
                status: 'success',
                beforeTokens,
                afterTokens,
                thresholdTokens,
                reductionPercent,
                summary: summaryText,
            }
        } catch (err) {
            return {
                reason,
                status: 'failed',
                beforeTokens,
                afterTokens: beforeTokens,
                thresholdTokens,
                reductionPercent: 0,
                errorMessage: (err as Error).message,
            }
        }
    }
}
