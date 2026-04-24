/**
 * @file spawn_agent 工具 — 方案一：同进程阻塞式子 Agent。
 *
 * 工作原理：
 *   父 Agent 调用 spawn_agent 工具
 *     → 工具内部创建独立的子 Session
 *     → 子 Session 执行 runTurn(task)（阻塞等待）
 *     → 子 Session 完成后，finalText 作为工具输出返回给父 Agent
 *     → 父 Agent 继续执行后续步骤
 *
 * 关键设计决策：
 *   1. 子 Session 历史完全独立，与父 Session 不共享
 *   2. 子 Agent 默认只使用"只读"工具集，避免嵌套写操作冲突
 *   3. 审批策略使用 auto（子 Agent 被父 Agent 信任，全部放行）
 *   4. 通过 onChunk 回调向父 Session 的 onAssistantChunk 转发进度
 */

import { randomUUID } from 'node:crypto'
import { Session } from '../runtime/session.js'
import type { ToolDefinition, ToolResult, CallLLM, ExecuteTool } from '../types.js'

/** 子 Agent 输出最大字符数（超过则截断，防止回灌到父 Agent 时撑爆上下文）。 */
const MAX_RESULT_CHARS = 10_000

// ─── 工厂函数参数 ──────────────────────────────────────────────────────────────

/**
 * 创建 spawn_agent 工具所需的外部依赖。
 *
 * 由 index.ts 在启动时注入，避免工具文件直接依赖全局状态。
 *
 * callLLM 支持 lazy proxy（函数），以破解与 callLLM 创建时的循环依赖。
 */
export type SpawnAgentDeps = {
    /** 共享的 LLM 调用函数（子 Agent 使用同一个 LLM 客户端）。 */
    callLLM: CallLLM
    /** 子 Agent 可用的工具执行函数（建议传入受限工具集）。 */
    executeTool: ExecuteTool
    /** 子 Agent 的系统提示词（可传父 Agent 的，也可传精简版）。 */
    systemPrompt?: string
    /** 单次 Turn 最大步骤数（默认 10，防止子 Agent 失控）。 */
    defaultMaxSteps?: number
}

// ─── 工具工厂 ─────────────────────────────────────────────────────────────────

/**
 * 创建方案一的 spawn_agent 工具。
 *
 * 用法：
 * ```ts
 * const spawnAgentTool = createSpawnAgentTool({
 *   callLLM,
 *   executeTool: roToolOrchestrator.createExecuteTool(),
 *   systemPrompt: childSystemPrompt,
 * })
 * router.registerNativeTools([spawnAgentTool])
 * ```
 */
export function createSpawnAgentTool(deps: SpawnAgentDeps): ToolDefinition {
    // Do NOT destructure callLLM here — deps.callLLM may be a lazy getter
    // that throws until index.ts has finished initialising the LLM client.
    const { executeTool, systemPrompt, defaultMaxSteps = 10 } = deps

    return {
        name: 'spawn_agent',
        description: [
            'Create a sub-agent to handle a specific task independently.',
            'The sub-agent has its own conversation history and runs to completion before returning.',
            'Use this to delegate focused sub-tasks (e.g., research a file, generate a report section).',
            'The sub-agent\'s final answer is returned as the tool result.',
            '',
            'Parameters:',
            '  task: The specific task for the sub-agent to perform.',
            '  context: Optional additional context to pass to the sub-agent.',
            '  max_steps: Maximum steps the sub-agent can take (default 10).',
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                task: {
                    type: 'string',
                    description: 'The task description for the sub-agent.',
                },
                context: {
                    type: 'string',
                    description: 'Optional context to prepend to the sub-agent\'s input.',
                },
                max_steps: {
                    type: 'number',
                    description: `Max steps (default ${defaultMaxSteps}).`,
                },
            },
            required: ['task'],
        },
        // spawn_agent 本身是非变更的（它会不会变更取决于子 Agent 工具集）
        isMutating: false,

        async execute(input): Promise<ToolResult> {
            const task = input['task'] as string | undefined
            const context = input['context'] as string | undefined
            const maxSteps = (input['max_steps'] as number | undefined) ?? defaultMaxSteps

            if (!task?.trim()) {
                return {
                    output: 'Error: spawn_agent requires a non-empty "task" parameter.',
                    isError: true,
                }
            }

            // ── 构造子 Agent 输入 ────────────────────────────────────────────
            // 如果有额外上下文，拼接到任务前面
            const agentInput = context
                ? `Context:\n${context}\n\nTask:\n${task}`
                : task

            // ── 创建子 Session ───────────────────────────────────────────────
            // Access deps.callLLM lazily — the getter resolves after index.ts
            // has finished wiring up subagentCallLLM.
            const childId = randomUUID()
            const childSession = new Session({
                sessionId: childId,
                callLLM: deps.callLLM,
                executeTool,
                systemPrompt,
                // 子 Agent 用较小的上下文窗口，避免嵌套爆窗
                contextWindow: 64_000,
                compactThreshold: 75,
                // 子 Agent 没有 TUI，无 Hook 注入
            })

            // ── 执行子 Agent ─────────────────────────────────────────────────
            let result
            try {
                result = await childSession.runTurn(agentInput)
            } catch (err) {
                return {
                    output: `Sub-agent [${childId.slice(0, 8)}] failed: ${(err as Error).message}`,
                    isError: true,
                }
            }

            // ── 构造返回输出 ─────────────────────────────────────────────────
            const shortId = childId.slice(0, 8)
            const stepCount = result.steps.length

            // 截断过长的子 Agent 输出，防止撑爆父 Agent 上下文
            const rawText = result.finalText
            const finalText = rawText.length > MAX_RESULT_CHARS
                ? rawText.slice(0, MAX_RESULT_CHARS) +
                  `\n...[truncated] Sub-agent output too long (${rawText.length} chars, max ${MAX_RESULT_CHARS})`
                : rawText

            if (result.status === 'error') {
                return {
                    output: [
                        `[Sub-agent ${shortId}] Failed after ${stepCount} step(s).`,
                        `Error: ${result.errorMessage ?? 'unknown'}`,
                        '',
                        `Last output: ${finalText}`,
                    ].join('\n'),
                    isError: true,
                }
            }

            return {
                output: [
                    `[Sub-agent ${shortId}] Completed in ${stepCount} step(s).`,
                    '',
                    finalText,
                ].join('\n'),
            }
        },
    }
}
