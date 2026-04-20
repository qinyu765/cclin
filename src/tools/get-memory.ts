/**
 * @file get_memory 工具 — 读取记忆文件（AGENTS.md / notes.md）。
 *
 * 支持两种 memory_id：
 *   - "project" → 读取 CWD 下的 AGENTS.md（项目级指令）
 *   - "notes"   → 读取 ~/.cclin/memories/notes.md（跨会话笔记）
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolDefinition } from '../types.js'

/** 获取 cclin 主目录，支持 CCLIN_HOME 环境变量重定向。 */
function getCclinHome(): string {
    return process.env.CCLIN_HOME ?? path.join(os.homedir(), '.cclin')
}

/** 支持的 memory_id 集合（路径在 execute 内按类型解析）。 */
const SUPPORTED_MEMORY_IDS = ['project', 'notes'] as const
type MemoryId = (typeof SUPPORTED_MEMORY_IDS)[number]

export const getMemoryTool: ToolDefinition = {
    name: 'get_memory',
    description:
        'Load stored memory for a given memory_id. ' +
        'Use memory_id "project" to read the project-level AGENTS.md. ' +
        'Use memory_id "notes" to read cross-session notes from ~/.cclin/memories/notes.md.',
    inputSchema: {
        type: 'object',
        properties: {
            memory_id: {
                type: 'string',
                enum: ['project', 'notes'],
                description:
                    'Memory identifier. "project" = AGENTS.md, "notes" = cross-session notes.',
            },
        },
        required: ['memory_id'],
    },
    isMutating: false,

    async execute(input) {
        const memoryId = String(input.memory_id ?? '').trim() as MemoryId
        if (!memoryId) {
            return { output: 'Error: memory_id is required.', isError: true }
        }

        if (!SUPPORTED_MEMORY_IDS.includes(memoryId)) {
            return {
                output: `Error: unknown memory_id "${memoryId}". Supported: ${SUPPORTED_MEMORY_IDS.join(', ')}`,
                isError: true,
            }
        }

        // 按类型解析文件路径
        let resolved: string
        if (memoryId === 'project') {
            resolved = path.resolve('AGENTS.md')
        } else {
            // notes → ~/.cclin/memories/notes.md
            resolved = path.join(getCclinHome(), 'memories', 'notes.md')
        }

        try {
            const content = await fs.readFile(resolved, 'utf-8')
            return {
                output: JSON.stringify(
                    { memory_id: memoryId, memory_summary: content },
                    null,
                    2,
                ),
            }
        } catch {
            if (memoryId === 'notes') {
                return {
                    output: JSON.stringify(
                        { memory_id: 'notes', memory_summary: '(no notes saved yet)' },
                        null,
                        2,
                    ),
                }
            }
            return {
                output: `memory not found for memory_id=${memoryId}`,
                isError: true,
            }
        }
    },
}
