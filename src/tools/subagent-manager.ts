/**
 * @file SubAgentManager — 方案二：异步子 Agent 注册表。
 *
 * 核心思路：
 *   父 Agent 通过工具调用来驱动子 Agent 的生命周期，
 *   每个子 Agent 是一个独立的 Session，但不立即阻塞父 Agent。
 *
 *   生命周期：
 *     spawn_agent  → 创建 Session，记录到 Map，返回 agent_id
 *     send_input   → 向指定 session.runTurn(message) 投递消息
 *                    （以 Promise 形式开始执行，但立即返回 "Running..."）
 *     wait         → await 该 Session 当前执行中的 Promise，返回结果
 *     close_agent  → 标记为 closed，释放引用
 *
 * 关键数据结构：
 *   _handles: Map<agentId, InternalHandle>
 *
 *   InternalHandle:
 *     session: Session          ← 子 Agent 的 Session 实例
 *     status: SubAgentStatus    ← 当前状态
 *     runningPromise: Promise?  ← 当前执行中的 runTurn Promise
 *     lastResult: string?       ← 上一次 Turn 的 finalText（wait 返回）
 */

import { randomUUID } from 'node:crypto'
import { Session } from '../runtime/session.js'
import type {
    CallLLM,
    ExecuteTool,
    ExecuteTools,
    SubAgentStatus,
    SubAgentHandle,
    TurnResult,
} from '../types.js'

// ─── 内部句柄（比公开类型多一个运行中的 Promise）──────────────────────────────

type InternalHandle = {
    id: string
    session: Session
    status: SubAgentStatus
    /** 当前正在执行的 runTurn Promise（send_input 后赋值，wait 后 await）。 */
    runningPromise: Promise<TurnResult> | null
    lastResult: string | undefined
    createdAt: string
}

// ─── SubAgentManager 类 ───────────────────────────────────────────────────────

/**
 * 子 Agent 管理器。
 *
 * 由 index.ts 在启动时创建一个单例，然后注入给 createAsyncSubAgentTools()。
 */
export class SubAgentManager {
    /** 最大同时存活的子 Agent 数量。 */
    private static readonly MAX_AGENTS = 5

    /** 所有活跃/已关闭的子 Agent 句柄。 */
    private readonly _handles = new Map<string, InternalHandle>()

    private readonly callLLM: CallLLM
    private readonly executeTool: ExecuteTool
    private readonly executeTools: ExecuteTools | undefined
    private readonly systemPrompt: string | undefined

    constructor(
        callLLM: CallLLM,
        executeTool: ExecuteTool,
        executeToolsOrSystemPrompt?: ExecuteTools | string,
        systemPrompt?: string,
    ) {
        this.callLLM = callLLM
        this.executeTool = executeTool
        this.executeTools = typeof executeToolsOrSystemPrompt === 'function'
            ? executeToolsOrSystemPrompt
            : undefined
        this.systemPrompt = typeof executeToolsOrSystemPrompt === 'string'
            ? executeToolsOrSystemPrompt
            : systemPrompt
    }

    // ── spawn ────────────────────────────────────────────────────────────────

    /**
     * 创建新的子 Agent（对应 spawn_agent 工具）。
     *
     * @returns 子 Agent 的唯一 ID
     * @throws 如果活跃子 Agent 数量已达上限
     */
    spawn(options?: { systemPrompt?: string }): string {
        // 并发数量限制
        const activeCount = Array.from(this._handles.values())
            .filter(h => h.status !== 'closed').length
        if (activeCount >= SubAgentManager.MAX_AGENTS) {
            throw new Error(
                `Maximum concurrent sub-agents (${SubAgentManager.MAX_AGENTS}) reached. ` +
                'Close an existing agent before spawning a new one.',
            )
        }

        const id = randomUUID()

        const session = new Session({
            sessionId: id,
            callLLM: this.callLLM,
            executeTool: this.executeTool,
            executeTools: this.executeTools,
            systemPrompt: options?.systemPrompt ?? this.systemPrompt,
            contextWindow: 64_000,
            compactThreshold: 75,
            // 子 Agent 共享父 Agent 的 callLLM，但历史独立
        })

        const handle: InternalHandle = {
            id,
            session,
            status: 'idle',
            runningPromise: null,
            lastResult: undefined,
            createdAt: new Date().toISOString(),
        }

        this._handles.set(id, handle)
        return id
    }

    // ── send_input ───────────────────────────────────────────────────────────

    /**
     * 向子 Agent 发送消息，开始（或继续）执行（对应 send_input 工具）。
     *
     * 关键点：
     *   - 调用后**立即返回**，不等待子 Agent 完成
     *   - 执行的 Promise 存储在 handle.runningPromise
     *   - 后续通过 wait() 等待结果
     *
     * @throws 如果 agent_id 不存在或子 Agent 已关闭/正在运行
     */
    sendInput(agentId: string, message: string): void {
        const handle = this._requireHandle(agentId)

        if (handle.status === 'closed') {
            throw new Error(`Sub-agent [${agentId.slice(0, 8)}] is already closed.`)
        }
        if (handle.status === 'running') {
            throw new Error(
                `Sub-agent [${agentId.slice(0, 8)}] is already running. ` +
                'Call wait() before sending another message.',
            )
        }

        handle.status = 'running'
        handle.runningPromise = handle.session.runTurn(message)

        // 后台更新状态（不 await，等 wait() 去真正等待）
        handle.runningPromise.then((result) => {
            handle.lastResult = result.finalText
            handle.status = 'idle_after_turn'
        }).catch(() => {
            handle.status = 'idle_after_turn'
        })
    }

    // ── wait ─────────────────────────────────────────────────────────────────

    /**
     * 等待子 Agent 完成当前 Turn（对应 wait 工具）。
     *
     * @returns 子 Agent 的最终输出文本
     * @throws 如果没有正在运行的任务
     */
    async wait(agentId: string): Promise<string> {
        const handle = this._requireHandle(agentId)

        if (handle.status === 'closed') {
            throw new Error(`Sub-agent [${agentId.slice(0, 8)}] is closed.`)
        }

        // 如果有正在运行的 Promise，真正等待它
        if (handle.runningPromise) {
            const result = await handle.runningPromise
            handle.runningPromise = null
            handle.lastResult = result.finalText
            handle.status = 'idle_after_turn'
            return result.finalText
        }

        // 否则返回缓存的上一次结果
        if (handle.lastResult !== undefined) {
            return handle.lastResult
        }

        throw new Error(
            `Sub-agent [${agentId.slice(0, 8)}] has no running task. ` +
            'Call send_input() first.',
        )
    }

    // ── close ─────────────────────────────────────────────────────────────────

    /**
     * 关闭子 Agent，释放资源（对应 close_agent 工具）。
     */
    close(agentId: string): void {
        const handle = this._requireHandle(agentId)
        handle.status = 'closed'
        // Note: 不能强制中断 runningPromise（JS 不支持取消 Promise），
        // 只标记状态，让后续的 wait() 知道已关闭
    }

    // ── 查询 ──────────────────────────────────────────────────────────────────

    /**
     * 返回当前所有子 Agent 的公开句柄快照。
     */
    listHandles(): SubAgentHandle[] {
        return Array.from(this._handles.values()).map((h) => ({
            id: h.id,
            status: h.status,
            lastResult: h.lastResult,
            createdAt: h.createdAt,
        }))
    }

    /**
     * 返回指定子 Agent 的公开句柄（不存在则返回 undefined）。
     */
    getHandle(agentId: string): SubAgentHandle | undefined {
        const h = this._handles.get(agentId)
        if (!h) return undefined
        return {
            id: h.id,
            status: h.status,
            lastResult: h.lastResult,
            createdAt: h.createdAt,
        }
    }

    // ── 内部工具 ─────────────────────────────────────────────────────────────

    private _requireHandle(agentId: string): InternalHandle {
        const handle = this._handles.get(agentId)
        if (!handle) {
            throw new Error(`Sub-agent not found: "${agentId}". Check the agent_id.`)
        }
        return handle
    }
}
