/**
 * @file bash 工具 — 执行 Shell 命令。
 */

import { execSync } from 'node:child_process'
import type { ToolDefinition } from '../types.js'
import { classifyCommand } from './safety.js'

const DEFAULT_TIMEOUT_MS = 30_000

export const bashTool: ToolDefinition = {
    name: 'bash',
    description:
        'Execute a shell command and return its output. ' +
        'Use this for running scripts, installing packages, ' +
        'checking system state, etc. ' +
        'Dangerous commands will be blocked.',
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The shell command to execute.' },
            timeout_ms: { type: 'number', description: 'Timeout in ms. Defaults to 30000.' },
        },
        required: ['command'],
    },
    isMutating: true,

    async execute(input) {
        const command = String(input.command ?? '')
        if (!command) return { output: 'Error: command is required.', isError: true }

        const safety = classifyCommand(command)
        if (safety === 'block') {
            return { output: `Blocked: "${command}" is a dangerous command.`, isError: true }
        }
        if (safety === 'confirm') {
            console.log(`  ⚠️ [bash] confirm-level command: ${command}`)
        }

        const timeout = Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS

        try {
            const result = execSync(command, {
                encoding: 'utf-8',
                timeout,
                maxBuffer: 1024 * 1024,
                stdio: ['pipe', 'pipe', 'pipe'],
            })
            return { output: result || '(no output)' }
        } catch (err) {
            const execErr = err as {
                status?: number
                stdout?: string
                stderr?: string
                message: string
            }

            const parts: string[] = []
            if (execErr.stdout) parts.push(execErr.stdout)
            if (execErr.stderr) parts.push(execErr.stderr)

            if (parts.length > 0) {
                const prefix = `Exit code: ${execErr.status ?? 'unknown'}\n`
                return { output: prefix + parts.join('\n') }
            }

            return { output: `bash failed: ${execErr.message}`, isError: true }
        }
    },
}
