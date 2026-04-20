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

// ─── 并行安全分类 ──────────────────────────────────────────────────────────────

/**
 * 只读 / 幂等工具：永远可以并行。
 * 条件：不修改任何外部状态（文件、进程、网络写入除外）。
 */
const PARALLEL_SAFE_TOOLS = new Set([
    'read_file',
    'list_directory',
    'search_files',
    'get_memory',
    'bash',  // 工具本身安全；破坏性命令由 safety.ts 拦截
])

/**
 * 永远不并行的工具：有交互副作用、需要用户响应，严格串行。
 */
const NEVER_PARALLEL_TOOLS = new Set([
    'spawn_agent',   // 子 Agent 启动，占用大量资源
    'send_input',    // 子 Agent 交互，需要序求保证
    'close_agent',   // 子 Agent 生命周期操作
    'wait_agent',    // 等待子 Agent，串行语义
])

/**
 * 判断一批工具调用是否可以并行执行。
 *
 * 规则（按优先级优先判断）：
 *   1. 只有 1 个调用 → 不并行（无意义开 Promise.all）
 *   2. 含 NEVER_PARALLEL_TOOLS → 全部串行
 *   3. 含 mutating 工具（isMutating=true）且 batch > 1 → 串行（避免并发写冲突）
 *   4. 全部在 PARALLEL_SAFE_TOOLS 里 → 并行
 *   5. 其他 → 串行（安全默认）
 */
function shouldParallelize(actions: ToolAction[], registry: ToolQueryable): boolean {
    if (actions.length <= 1) return false

    const names = actions.map(a => a.name)

    if (names.some(n => NEVER_PARALLEL_TOOLS.has(n))) return false

    for (const name of names) {
        const tool = registry.get(name)
        if (tool?.isMutating) return false
    }

    if (names.every(n => PARALLEL_SAFE_TOOLS.has(n))) return true

    return false
}

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
     * 批量执行工具调用（智能并行 / 串行自动切换）。
     *
     * 调用路径：
     *   - shouldParallelize() 返回 true → Promise.all 并发执行所有 action
     *   - 否则 → for...of 逐个执行（遇到 approval_denied 时提前中断）
     *
     * 并行时：审批拦截仍然工作。如果允许并行的工具需要审批，
     * 审批回调仍会被调用，但多个并行审批请求会同时弹出。
     */
    async executeActions(
        actions: ToolAction[],
        hooks?: ApprovalHooks,
    ): Promise<ToolExecutionResult> {
        if (shouldParallelize(actions, this.registry)) {
            // ─── 并行执行 ────────────────────────────────────────────────
            const results = await Promise.all(
                actions.map(action => this.executeAction(action, hooks))
            )

            const hasRejection = results.some(r => r.status === 'approval_denied')
            const combinedObservation = results
                .map(r => r.observation)
                .join('\n---\n')

            return { results, combinedObservation, hasRejection }
        }

        // ─── 串行执行 ────────────────────────────────────────────────────
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
