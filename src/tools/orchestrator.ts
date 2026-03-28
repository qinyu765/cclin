/**
 * @file 工具编排器 — 统一调度工具执行。
 *
 * Phase 4：在 ToolRegistry 和 ReAct 循环之间的中间层。
 *
 * 职责链：工具查找 → 审批检查 → 输入解析 → 执行 → 错误分类 → 结果截断
 *
 * 设计思路：
 *   1. 将散落在 registry.createExecuteTool() 和 react-loop 中的
 *      执行逻辑集中到一个统一入口。
 *   2. 通过 ApprovalHooks 回调将审批 UI 解耦。
 *   3. 提供 createExecuteTool() 兼容现有 ReAct 循环接口。
 */

import type {
    ExecuteTool,
    ApprovalHooks,
    ApprovalRequest,
    ToolAction,
    ToolActionResult,
    ToolActionStatus,
    ToolExecutionResult,
    ToolQueryable,
} from '../types.js'
import type { ApprovalManager } from './approval.js'

/** 工具输出最大字符数（超过则截断）。 */
const MAX_OUTPUT_CHARS = 50_000

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 截断过长的工具输出。 */
function truncateOutput(output: string, toolName: string): string {
    if (output.length <= MAX_OUTPUT_CHARS) return output
    return (
        output.slice(0, MAX_OUTPUT_CHARS) +
        `\n...[truncated] ${toolName} output too long ` +
        `(${output.length} chars, max ${MAX_OUTPUT_CHARS})`
    )
}

/** 解析工具输入，确保为 Record 类型。 */
function parseToolInput(
    rawInput: unknown,
): Record<string, unknown> {
    if (rawInput === null || rawInput === undefined) return {}
    if (typeof rawInput === 'object' && !Array.isArray(rawInput)) {
        return rawInput as Record<string, unknown>
    }
    if (typeof rawInput === 'string') {
        try {
            const parsed = JSON.parse(rawInput)
            if (typeof parsed === 'object' && parsed !== null) {
                return parsed as Record<string, unknown>
            }
        } catch {
            // 解析失败，返回空对象
        }
    }
    return {}
}

/** 错误分类。 */
function classifyError(err: unknown): ToolActionStatus {
    const msg = err instanceof Error
        ? err.message.toLowerCase()
        : String(err).toLowerCase()
    if (
        msg.includes('permission denied') ||
        msg.includes('eacces')
    ) {
        return 'execution_failed'
    }
    return 'execution_failed'
}

// ─── ToolOrchestrator 类 ─────────────────────────────────────────────────────

/**
 * 工具编排器。
 *
 * 统一的工具执行入口，包含：
 *   1. 工具查找
 *   2. 审批检查
 *   3. 输入解析
 *   4. 工具执行
 *   5. 错误分类
 *   6. 结果截断
 */
export class ToolOrchestrator {
    constructor(
        private readonly registry: ToolQueryable,
        private readonly approvalManager: ApprovalManager,
    ) {}

    /**
     * 执行单个工具调用。
     *
     * 完整流程：查找 → 审批 → 解析 → 执行 → 截断
     */
    async executeAction(
        action: ToolAction,
        hooks?: ApprovalHooks,
    ): Promise<ToolActionResult> {
        const startedAt = Date.now()

        // 1. 工具查找
        const tool = this.registry.get(action.name)
        if (!tool) {
            return {
                actionId: action.id,
                tool: action.name,
                status: 'tool_not_found',
                success: false,
                observation: `Error: tool "${action.name}" not found.`,
                durationMs: Date.now() - startedAt,
            }
        }

        // 2. 审批检查
        const check = this.approvalManager.check(
            action.name,
            action.input,
            tool.isMutating,
        )

        if (check.needsApproval) {
            const request: ApprovalRequest = {
                toolName: check.toolName,
                input: check.input,
                fingerprint: check.fingerprint,
                reason: check.reason,
            }

            // 调用 UI 审批回调
            const decision = hooks?.requestApproval
                ? await hooks.requestApproval(request)
                : 'deny'

            this.approvalManager.recordDecision(
                check.fingerprint,
                decision,
            )

            if (decision === 'deny') {
                return {
                    actionId: action.id,
                    tool: action.name,
                    status: 'approval_denied',
                    success: false,
                    observation:
                        `User denied: "${action.name}". ` +
                        'Please inform the user and suggest alternatives.',
                    durationMs: Date.now() - startedAt,
                }
            }
        }

        // 3. 输入解析
        const parsedInput = parseToolInput(action.input)

        // 4. 执行工具
        try {
            const result = await tool.execute(parsedInput)

            // 5. 结果截断
            const output = truncateOutput(
                result.output,
                action.name,
            )

            return {
                actionId: action.id,
                tool: action.name,
                status: result.isError ? 'execution_failed' : 'success',
                success: !result.isError,
                observation: output,
                durationMs: Date.now() - startedAt,
            }
        } catch (err) {
            return {
                actionId: action.id,
                tool: action.name,
                status: classifyError(err),
                success: false,
                observation: `Tool execution error: ${(err as Error).message}`,
                durationMs: Date.now() - startedAt,
            }
        }
    }

    /**
     * 批量执行工具调用（顺序执行）。
     */
    async executeActions(
        actions: ToolAction[],
        hooks?: ApprovalHooks,
    ): Promise<ToolExecutionResult> {
        const results: ToolActionResult[] = []

        for (const action of actions) {
            const result = await this.executeAction(action, hooks)
            results.push(result)

            // 如果被拒绝，停止后续执行   
            if (result.status === 'approval_denied') break
        }

        const hasRejection = results.some(
            (r) => r.status === 'approval_denied',
        )
        const combinedObservation = results
            .map((r) => r.observation)
            .join('\n---\n')

        return { results, combinedObservation, hasRejection }
    }

    /**
     * 创建兼容 ExecuteTool 签名的函数。
     *
     * 让 Orchestrator 可以无缝接入现有 ReAct 循环。
     */
    createExecuteTool(hooks?: ApprovalHooks): ExecuteTool {
        return async (
            toolName: string,
            toolInput: unknown,
        ): Promise<string> => {
            const action: ToolAction = {
                id: `${toolName}:${Date.now()}`,
                name: toolName,
                input: toolInput,
            }
            const result = await this.executeAction(action, hooks)
            return result.observation
        }
    }

    /** 清除 once 级别授权（Turn 结束时调用）。 */
    clearOnceApprovals(): void {
        this.approvalManager.clearOnceApprovals()
    }

    /** 清除所有授权（Session 结束时调用）。 */
    dispose(): void {
        this.approvalManager.dispose()
    }
}
