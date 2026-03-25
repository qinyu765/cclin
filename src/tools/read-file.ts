/**
 * @file read_file 工具 — 读取文件内容，支持 offset/limit 分段。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDefinition } from '../types.js'
import { validatePath } from './safety.js'

export const readFileTool: ToolDefinition = {
    name: 'read_file',
    description:
        'Read the contents of a file. Supports offset/limit for partial reads. ' +
        'Returns line-numbered output.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path to read.' },
            offset: { type: 'number', description: 'Start line (0-based, default 0).' },
            limit: { type: 'number', description: 'Max lines to return (default: all).' },
        },
        required: ['path'],
    },
    isMutating: false,

    async execute(input) {
        const filePath = String(input.path ?? '')
        if (!filePath) return { output: 'Error: path is required.', isError: true }

        const validation = validatePath(filePath)
        if (!validation.ok) return { output: validation.error, isError: true }

        const resolved = path.resolve(filePath)

        try {
            const raw = await fs.readFile(resolved, 'utf-8')
            let lines = raw.split('\n')

            const offset = Math.max(0, Number(input.offset) || 0)
            const limit = Number(input.limit) || 0

            if (offset > 0 || limit > 0) {
                const end = limit > 0 ? offset + limit : undefined
                lines = lines.slice(offset, end)
            }

            const numbered = lines.map((line, i) =>
                `${offset + i + 1}: ${line}`,
            ).join('\n')

            return { output: `File: ${resolved}\n${numbered}` }
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            const msg = code === 'ENOENT'
                ? `File not found: ${resolved}`
                : `read_file failed: ${(err as Error).message}`
            return { output: msg, isError: true }
        }
    },
}
