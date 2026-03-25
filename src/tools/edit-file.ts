/**
 * @file edit_file 工具 — 文件内容替换。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDefinition } from '../types.js'
import { validatePath } from './safety.js'

export const editFileTool: ToolDefinition = {
    name: 'edit_file',
    description:
        'Edit a file by replacing old_text with new_text. ' +
        'The old_text must match exactly (including whitespace).',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path to edit.' },
            old_text: { type: 'string', description: 'Exact text to find and replace.' },
            new_text: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_text', 'new_text'],
    },
    isMutating: true,

    async execute(input) {
        const filePath = String(input.path ?? '')
        const oldText = String(input.old_text ?? '')
        const newText = String(input.new_text ?? '')
        if (!filePath) return { output: 'Error: path is required.', isError: true }
        if (!oldText) return { output: 'Error: old_text is required.', isError: true }

        const validation = validatePath(filePath)
        if (!validation.ok) return { output: validation.error, isError: true }

        const resolved = path.resolve(filePath)

        try {
            const original = await fs.readFile(resolved, 'utf-8')
            const idx = original.indexOf(oldText)
            if (idx === -1) {
                return { output: 'Error: old_text not found in file.', isError: true }
            }
            const secondIdx = original.indexOf(oldText, idx + 1)
            if (secondIdx !== -1) {
                return { output: 'Error: old_text matches multiple locations. Please provide more specific text.', isError: true }
            }

            const updated = original.replace(oldText, newText)
            await fs.writeFile(resolved, updated, 'utf-8')

            const oldLines = oldText.split('\n').length
            const newLines = newText.split('\n').length
            return { output: `File edited: ${resolved} (replaced ${oldLines} lines with ${newLines} lines)` }
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            const msg = code === 'ENOENT'
                ? `File not found: ${resolved}`
                : `edit_file failed: ${(err as Error).message}`
            return { output: msg, isError: true }
        }
    },
}
