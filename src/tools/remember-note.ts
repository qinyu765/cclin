/**
 * @file remember_note 工具 — 向跨会话记忆文件追加笔记。
 *
 * 笔记保存在 ~/.cclin/memories/notes.md，
 * 每条记录附带时间戳和可选分类标签，方便后续检索。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolDefinition } from '../types.js'

/** 获取 cclin 主目录，支持 CCLIN_HOME 环境变量重定向。 */
function getCclinHome(): string {
    return process.env.CCLIN_HOME ?? path.join(os.homedir(), '.cclin')
}

/** 返回 notes.md 的完整路径。 */
function getNotesPath(): string {
    return path.join(getCclinHome(), 'memories', 'notes.md')
}

export const rememberNoteTool: ToolDefinition = {
    name: 'remember_note',
    description:
        'Append a note to the cross-session memory file (~/.cclin/memories/notes.md). ' +
        'Use this to remember user preferences, project conventions, or solutions ' +
        'that should persist across future sessions.',
    inputSchema: {
        type: 'object',
        properties: {
            content: {
                type: 'string',
                description: 'The note content to remember.',
            },
            category: {
                type: 'string',
                description:
                    'Optional category label (e.g. "preference", "convention", "solution").',
            },
        },
        required: ['content'],
    },
    isMutating: true,

    async execute(input) {
        const content = String(input.content ?? '').trim()
        if (!content) {
            return { output: 'Error: content is required.', isError: true }
        }

        const category = input.category ? String(input.category).trim() : ''
        const notesPath = getNotesPath()

        // 确保目录存在
        await fs.mkdir(path.dirname(notesPath), { recursive: true })

        // 构造追加内容
        const date = new Date().toISOString().split('T')[0] // YYYY-MM-DD
        const header = category ? `[${date}] (${category})` : `[${date}]`
        const entry = `\n---\n${header}\n${content}\n`

        await fs.appendFile(notesPath, entry, 'utf-8')

        return {
            output: `Note saved to ${notesPath}\n${header}\n${content}`,
        }
    },
}
