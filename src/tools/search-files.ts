/**
 * @file search_files 工具 — 递归搜索文件名匹配。
 *
 * 参考 memo-code 的 search_files.ts，
 * 用简单的 glob 匹配让 Agent 能快速定位文件。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDefinition } from '../types.js'
import { validatePath } from './safety.js'

/** 默认排除的目录。 */
const DEFAULT_EXCLUDES = new Set([
    'node_modules', '.git', 'dist', '.next',
    '__pycache__', '.venv', 'coverage',
])

/** 最大返回条数。 */
const MAX_RESULTS = 100

/**
 * 简单 glob 匹配（仅支持 * 通配符）。
 * 例如 `*.ts` 匹配 `foo.ts`，`test*` 匹配 `test-utils.ts`。
 */
function matchGlob(filename: string, pattern: string): boolean {
    const regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
    return new RegExp(`^${regex}$`, 'i').test(filename)
}

/** 递归搜索目录。 */
async function searchDir(
    dir: string,
    pattern: string,
    results: string[],
): Promise<void> {
    if (results.length >= MAX_RESULTS) return

    let entries: import('node:fs').Dirent[]
    try {
        entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf-8' }) as import('node:fs').Dirent[]
    } catch {
        return // 无权限等情况，静默跳过
    }

    for (const entry of entries) {
        if (results.length >= MAX_RESULTS) break

        if (entry.isDirectory()) {
            if (DEFAULT_EXCLUDES.has(entry.name)) continue
            await searchDir(
                path.join(dir, entry.name), pattern, results,
            )
        } else if (matchGlob(entry.name, pattern)) {
            results.push(path.join(dir, entry.name))
        }
    }
}

export const searchFilesTool: ToolDefinition = {
    name: 'search_files',
    description:
        'Recursively search files by glob pattern. ' +
        'Returns matching file paths (max 100). ' +
        'Automatically excludes node_modules, .git, dist.',
    inputSchema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Root directory to search from.',
            },
            pattern: {
                type: 'string',
                description:
                    'Glob pattern to match filenames ' +
                    '(e.g. "*.ts", "test*").',
            },
        },
        required: ['path', 'pattern'],
    },
    isMutating: false,

    async execute(input) {
        const searchPath = String(input.path ?? '').trim()
        const pattern = String(input.pattern ?? '').trim()

        if (!searchPath) {
            return { output: 'Error: path is required.', isError: true }
        }
        if (!pattern) {
            return { output: 'Error: pattern is required.', isError: true }
        }

        const validation = validatePath(searchPath)
        if (!validation.ok) {
            return { output: validation.error, isError: true }
        }

        const resolved = path.resolve(searchPath)

        try {
            const stat = await fs.stat(resolved)
            if (!stat.isDirectory()) {
                return {
                    output: `Error: ${resolved} is not a directory.`,
                    isError: true,
                }
            }
        } catch {
            return {
                output: `Error: directory not found: ${resolved}`,
                isError: true,
            }
        }

        const results: string[] = []
        await searchDir(resolved, pattern, results)

        if (results.length === 0) {
            return { output: 'No matches found.' }
        }

        const truncated = results.length >= MAX_RESULTS
            ? `\n(truncated at ${MAX_RESULTS} results)`
            : ''

        return {
            output: results.join('\n') + truncated,
        }
    },
}
