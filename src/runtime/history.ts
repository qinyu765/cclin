/**
 * @file 会话历史持久化 — JSONL 格式写入。
 *
 * 参考 memo-code 的 history.ts，
 * 每个事件写为一行 JSON，支持串行写入队列。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
    HistoryEvent,
    HistoryEventType,
    HistorySink,
    Role,
} from '../types.js'

// ─── JsonlHistorySink ────────────────────────────────────────────────────────

/** JSONL 历史写入器：每条事件一行 JSON。 */
export class JsonlHistorySink implements HistorySink {
    private ensureDirPromise: Promise<void> | null = null
    private writeQueue: Promise<void> = Promise.resolve()
    private closed = false

    constructor(private filePath: string) {}

    /** 确保目标目录存在。 */
    private ensureDirectory(): Promise<void> {
        if (!this.ensureDirPromise) {
            this.ensureDirPromise = mkdir(
                dirname(this.filePath),
                { recursive: true },
            ).then(() => {})
        }
        return this.ensureDirPromise
    }

    /** 追加一条事件到 JSONL 文件。 */
    async append(event: HistoryEvent): Promise<void> {
        if (this.closed) {
            throw new Error('History sink is closed')
        }
        this.writeQueue = this.writeQueue.then(async () => {
            await this.ensureDirectory()
            await appendFile(
                this.filePath,
                `${JSON.stringify(event)}\n`,
                'utf8',
            )
        })
        return this.writeQueue
    }

    /** 等待所有挂起的写入完成。 */
    async flush(): Promise<void> {
        await this.writeQueue
    }

    /** 关闭写入器。 */
    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        await this.flush()
    }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 创建一条结构化历史事件。 */
export function createHistoryEvent(params: {
    sessionId: string
    type: HistoryEventType
    turn?: number
    step?: number
    content?: string
    role?: Role
    meta?: Record<string, unknown>
}): HistoryEvent {
    return {
        ts: new Date().toISOString(),
        sessionId: params.sessionId,
        type: params.type,
        turn: params.turn,
        step: params.step,
        content: params.content,
        role: params.role,
        meta: params.meta,
    }
}
