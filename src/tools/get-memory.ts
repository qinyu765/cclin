/**
 * @file get_memory 工具 — 读取项目级记忆（AGENTS.md）。
 *
 * 参考 memo-code 的 get_memory.ts，
 * 让 Agent 能在需要时检索项目的关键指令和上下文。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDefinition } from '../types.js'

/** 支持的 memory_id → 文件路径映射。 */
const MEMORY_FILES: Record<string, string> = {
    project: 'AGENTS.md',
}

export const getMemoryTool: ToolDefinition = {
    name: 'get_memory',
    description:
        'Load stored memory for a given memory_id. ' +
        'Use memory_id "project" to read the project-level AGENTS.md.',
    inputSchema: {
        type: 'object',
        properties: {
            memory_id: {
                type: 'string',
                description:
                    'Memory identifier. Currently supports: "project".',
            },
        },
        required: ['memory_id'],
    },
    isMutating: false,

    async execute(input) {
        const memoryId = String(input.memory_id ?? '').trim()
        if (!memoryId) {
            return { output: 'Error: memory_id is required.', isError: true }
        }

        const filename = MEMORY_FILES[memoryId]
        if (!filename) {
            const supported = Object.keys(MEMORY_FILES).join(', ')
            return {
                output: `Error: unknown memory_id "${memoryId}". Supported: ${supported}`,
                isError: true,
            }
        }

        const resolved = path.resolve(filename)

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
            return {
                output: `memory not found for memory_id=${memoryId}`,
                isError: true,
            }
        }
    },
}
