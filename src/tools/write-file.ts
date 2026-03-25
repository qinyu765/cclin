/**
 * @file write_file 工具 — 写入/创建文件。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDefinition } from '../types.js'
import { validatePath } from './safety.js'

export const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description:
        'Write content to a file. Creates the file and ' +
        'parent directories if they do not exist. ' +
        'Overwrites existing file content.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path to write to.' },
            content: { type: 'string', description: 'Content to write.' },
        },
        required: ['path', 'content'],
    },
    isMutating: true,

    async execute(input) {
        const filePath = String(input.path ?? '')
        const content = String(input.content ?? '')
        if (!filePath) return { output: 'Error: path is required.', isError: true }

        const validation = validatePath(filePath)
        if (!validation.ok) return { output: validation.error, isError: true }

        const resolved = path.resolve(filePath)

        try {
            await fs.mkdir(path.dirname(resolved), { recursive: true })
            await fs.writeFile(resolved, content, 'utf-8')
            const lines = content.split('\n').length
            return { output: `File written: ${resolved} (${lines} lines, ${content.length} bytes)` }
        } catch (err) {
            return { output: `write_file failed: ${(err as Error).message}`, isError: true }
        }
    },
}
