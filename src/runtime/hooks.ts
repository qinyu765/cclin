/**
 * @file Hook 系统 — 生命周期钩子的注册与执行引擎。
 *
 * Phase 7：提供 HookRunnerMap 注册表和 runHook() 安全执行器，
 * 让 ReAct 循环在关键节点发射事件，由外部中间件处理 UI/日志等。
 *
 * 设计要点：
 *   - runHook() 内部 try/catch，单个 handler 失败不影响主流程
 *   - snapshotHistory() 深拷贝历史，防止 hook 修改共享状态
 *   - buildHookRunners() 合并 hooks + middlewares 到统一注册表
 */

import type {
    ChatMessage,
    AgentHooks,
    AgentMiddleware,
    AgentHookHandler,
    TurnStartHookPayload,
    ActionHookPayload,
    ObservationHookPayload,
    FinalHookPayload,
    ContextUsageHookPayload,
    ContextCompactedHookPayload,
    ApprovalHookPayload,
    ApprovalResponseHookPayload,
    TitleGeneratedHookPayload,
} from '../types.js'

// ─── 类型定义 ────────────────────────────────────────────────────────────────

/** 9 种 Hook 名称。 */
export type HookName =
    | 'onTurnStart'
    | 'onAction'
    | 'onObservation'
    | 'onFinal'
    | 'onContextUsage'
    | 'onContextCompacted'
    | 'onApprovalRequest'
    | 'onApprovalResponse'
    | 'onTitleGenerated'

/** Hook 名称 → Payload 类型映射。 */
export type HookPayloadMap = {
    onTurnStart: TurnStartHookPayload
    onAction: ActionHookPayload
    onObservation: ObservationHookPayload
    onFinal: FinalHookPayload
    onContextUsage: ContextUsageHookPayload
    onContextCompacted: ContextCompactedHookPayload
    onApprovalRequest: ApprovalHookPayload
    onApprovalResponse: ApprovalResponseHookPayload
    onTitleGenerated: TitleGeneratedHookPayload
}

/** Hook 注册表：每个 hook 名称对应一个 handler 数组。 */
export type HookRunnerMap = {
    [K in HookName]: AgentHookHandler<HookPayloadMap[K]>[]
}

// ─── 内部工具函数 ─────────────────────────────────────────────────────────────

/** 创建空的 Hook 注册表。 */
function emptyHookMap(): HookRunnerMap {
    return {
        onTurnStart: [],
        onAction: [],
        onObservation: [],
        onFinal: [],
        onContextUsage: [],
        onContextCompacted: [],
        onApprovalRequest: [],
        onApprovalResponse: [],
        onTitleGenerated: [],
    }
}

/**
 * 将单个中间件的 handler 注册到注册表中。
 *
 * 遍历中间件上所有可选的 hook 属性，
 * 如果存在则 push 到对应数组。
 */
function registerMiddleware(
    target: HookRunnerMap,
    middleware?: AgentHooks,
): void {
    if (!middleware) return
    if (middleware.onTurnStart) target.onTurnStart.push(middleware.onTurnStart)
    if (middleware.onAction) target.onAction.push(middleware.onAction)
    if (middleware.onObservation) target.onObservation.push(middleware.onObservation)
    if (middleware.onFinal) target.onFinal.push(middleware.onFinal)
    if (middleware.onContextUsage) target.onContextUsage.push(middleware.onContextUsage)
    if (middleware.onContextCompacted) target.onContextCompacted.push(middleware.onContextCompacted)
    if (middleware.onApprovalRequest) target.onApprovalRequest.push(middleware.onApprovalRequest)
    if (middleware.onApprovalResponse) target.onApprovalResponse.push(middleware.onApprovalResponse)
    if (middleware.onTitleGenerated) target.onTitleGenerated.push(middleware.onTitleGenerated)
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

/**
 * 从 hooks + middlewares 配置构建统一的 HookRunnerMap。
 *
 * hooks 先注册，然后按顺序注册每个 middleware。
 * 这样 hooks 里的 handler 总是最先执行。
 */
export function buildHookRunners(
    hooks?: AgentHooks,
    middlewares?: AgentMiddleware[],
): HookRunnerMap {
    const map = emptyHookMap()
    registerMiddleware(map, hooks)
    if (Array.isArray(middlewares)) {
        for (const mw of middlewares) {
            registerMiddleware(map, mw)
        }
    }
    return map
}

/**
 * 安全执行指定 Hook 的所有 handler。
 *
 * 关键设计：每个 handler 独立 try/catch，
 * 一个 handler 抛错不会阻止后续 handler 执行，
 * 也不会影响主流程（ReAct 循环继续）。
 */
export async function runHook<K extends HookName>(
    map: HookRunnerMap,
    name: K,
    payload: HookPayloadMap[K],
): Promise<void> {
    const handlers = map[name]
    if (!handlers.length) return
    for (const handler of handlers) {
        try {
            await handler(payload)
        } catch (err) {
            console.warn(`Hook ${name} failed: ${(err as Error).message}`)
        }
    }
}

/**
 * 深拷贝对话历史（传给 hook 的快照）。
 *
 * 防止 hook 中的代码意外修改共享的 history 数组。
 * 对 assistant 消息的 tool_calls 做三层拷贝，
 * 确保 function 对象也是独立副本。
 */
export function snapshotHistory(history: ChatMessage[]): ChatMessage[] {
    return history.map((msg) => {
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
            return {
                ...msg,
                tool_calls: msg.tool_calls.map((tc) => ({
                    ...tc,
                    function: { ...tc.function },
                })),
            }
        }
        return { ...msg }
    })
}
