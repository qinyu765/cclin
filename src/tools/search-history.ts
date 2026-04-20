/**
 * @file search_history 工具 — 从 JSONL 历史文件中全文搜索过往会话记录。
 *
 * 方案 A（grep 版）：逐行读取 ~/.cclin/history/*.jsonl，
 * 检查 content 字段是否包含 query 关键字，
 * 仅返回 type === 'final' 的条目（assistant 最终回答），按时间倒序。
 *
 * 无需额外依赖，纯 Node.js 标准库实现。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { HistoryEvent, ToolDefinition } from '../types.js'

/** 获取 cclin 主目录，支持 CCLIN_HOME 环境变量重定向。 */
function getCclinHome(): string {
    return process.env.CCLIN_HOME ?? path.join(os.homedir(), '.cclin')
}

/** 获取历史目录路径。 */
function getHistoryDir(): string {
    return path.join(getCclinHome(), 'history')
}

/** 将搜索结果格式化为人类可读的摘录文本。 */
function formatResult(event: HistoryEvent, filePath: string): string {
    const date = event.ts.slice(0, 10) // YYYY-MM-DD
    const time = event.ts.slice(11, 19) // HH:MM:SS
    const sessionId = event.sessionId.slice(0, 8) // 前 8 位足够辨识
    const snippet =
        (event.content ?? '').length > 300
            ? event.content!.slice(0, 300) + '…'
            : (event.content ?? '')
    const basename = path.basename(filePath)
    return `[${date} ${time}] session=${sessionId} (${basename})\n${snippet}`
}

export const searchHistoryTool: ToolDefinition = {
    name: 'search_history',
    description:
        'Search past conversation history for messages matching a query. ' +
        'Scans ~/.cclin/history/*.jsonl files and returns matching assistant responses, ' +
        'ordered newest first. Useful for recalling how a previous problem was solved.',
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Keyword or phrase to search for in past conversations.',
            },
            limit: {
                type: 'string',
                description: 'Maximum number of results to return (default: 10).',
            },
        },
        required: ['query'],
    },
    isMutating: false,

    async execute(input) {
        const query = String(input.query ?? '').trim()
        if (!query) {
            return { output: 'Error: query is required.', isError: true }
        }
        const limit = Math.min(Math.max(1, Number(input.limit) || 10), 50)

        const historyDir = getHistoryDir()

        // 历史目录不存在时提前返回
        try {
            await fs.access(historyDir)
        } catch {
            return {
                output: 'No history found. The history directory does not exist yet.',
            }
        }

        // 列出所有 .jsonl 文件
        const files = (await fs.readdir(historyDir))
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => path.join(historyDir, f))

        if (files.length === 0) {
            return { output: 'No history files found.' }
        }

        const queryLower = query.toLowerCase()
        const matches: Array<{ ts: string; text: string }> = []

        for (const filePath of files) {
            const raw = await fs.readFile(filePath, 'utf-8')
            const lines = raw.split('\n').filter((l) => l.trim())

            for (const line of lines) {
                let event: HistoryEvent
                try {
                    event = JSON.parse(line) as HistoryEvent
                } catch {
                    continue // 跳过损坏的行
                }

                // 只搜索 assistant 最终回答
                if (event.type !== 'final') continue
                if (!event.content) continue

                // 大小写不敏感匹配
                if (!event.content.toLowerCase().includes(queryLower)) continue

                matches.push({
                    ts: event.ts,
                    text: formatResult(event, filePath),
                })
            }
        }

        if (matches.length === 0) {
            return {
                output: `No results found for "${query}" in ${files.length} history file(s).`,
            }
        }

        // 按时间倒序，截取 limit 条
        matches.sort((a, b) => b.ts.localeCompare(a.ts))
        const top = matches.slice(0, limit)

        const header = `Found ${matches.length} result(s) for "${query}" (showing top ${top.length}):\n`
        const body = top.map((m, i) => `--- Result ${i + 1} ---\n${m.text}`).join('\n\n')

        return { output: header + body }
    },
}
