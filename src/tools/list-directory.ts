/**
 * @file list_directory 工具 — 列出目录内容。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDefinition } from '../types.js'
import { validatePath } from './safety.js'

export const listDirectoryTool: ToolDefinition = {
    name: 'list_directory',
    description:
        'List the contents of a directory. ' +
        'Returns file names, types (file/dir), and sizes.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Directory path to list.' },
        },
        required: ['path'],
    },
    isMutating: false,

    async execute(input) {
        const dirPath = String(input.path ?? '')
        if (!dirPath) return { output: 'Error: path is required.', isError: true }

        const validation = validatePath(dirPath)
        if (!validation.ok) return { output: validation.error, isError: true }

        const resolved = path.resolve(dirPath)

        // Common directories that pollute context when listed
        const IGNORED_DIRS = new Set([
            'node_modules', '.git', '.next', '.nuxt', 'dist', 'build',
            '.cache', '.turbo', '.output', '__pycache__', '.pytest_cache',
            'coverage', '.nyc_output', '.parcel-cache', '.svelte-kit',
        ])

        try {
            const entries = await fs.readdir(resolved, { withFileTypes: true })
            if (entries.length === 0) {
                return { output: `${resolved}/ (empty directory)` }
            }

            const lines: string[] = []
            let hiddenCount = 0

            for (const entry of entries) {
                // Skip noisy directories
                if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
                    hiddenCount++
                    continue
                }

                const fullPath = path.join(resolved, entry.name)
                if (entry.isDirectory()) {
                    lines.push(`  [DIR]  ${entry.name}/`)
                } else {
                    try {
                        const stat = await fs.stat(fullPath)
                        lines.push(`  [FILE] ${entry.name} (${formatSize(stat.size)})`)
                    } catch {
                        lines.push(`  [FILE] ${entry.name}`)
                    }
                }
            }

            let output = `${resolved}/ (${entries.length} entries)\n${lines.join('\n')}`
            if (hiddenCount > 0) {
                output += `\n\n  (${hiddenCount} directories hidden: ${[...IGNORED_DIRS].filter(d => entries.some(e => e.name === d)).join(', ')})`
            }

            return { output }
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            const msg = code === 'ENOENT'
                ? `Directory not found: ${resolved}`
                : code === 'ENOTDIR'
                  ? `Not a directory: ${resolved}`
                  : `list_directory failed: ${(err as Error).message}`
            return { output: msg, isError: true }
        }
    },
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
