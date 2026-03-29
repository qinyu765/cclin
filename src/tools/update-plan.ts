/**
 * @file update_plan 工具 — 创建/更新结构化计划文件。
 *
 * Phase 10：让 Agent 能追踪多步任务的进度。
 * 生成 Markdown 格式的计划清单，写入 .{plan_id}.plan.md。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDefinition } from '../types.js'
import { validatePath } from './safety.js'

/** 单个计划步骤。 */
type PlanStep = {
    description: string
    status: 'pending' | 'in_progress' | 'done'
}

/** 状态 → Markdown checkbox 映射。 */
const STATUS_MAP: Record<PlanStep['status'], string> = {
    pending: '[ ]',
    in_progress: '[/]',
    done: '[x]',
}

export const updatePlanTool: ToolDefinition = {
    name: 'update_plan',
    description:
        'Create or update a structured plan file (.plan.md) ' +
        'in the project workspace. Use this to track multi-step ' +
        'task progress with a checklist.',
    inputSchema: {
        type: 'object',
        properties: {
            plan_id: {
                type: 'string',
                description:
                    'Plan identifier, used as filename ' +
                    '(e.g. "refactor-auth" → .refactor-auth.plan.md).',
            },
            title: {
                type: 'string',
                description: 'Plan title (Markdown heading).',
            },
            steps: {
                type: 'array',
                description:
                    'Array of step objects. Each has: ' +
                    'description (string), ' +
                    'status ("pending"|"in_progress"|"done").',
                items: { type: 'object' },
            },
            notes: {
                type: 'string',
                description: 'Optional notes section appended at end.',
            },
        },
        required: ['plan_id', 'title', 'steps'],
    },
    isMutating: true,

    async execute(input) {
        const planId = String(input.plan_id ?? '').trim()
        const title = String(input.title ?? '').trim()
        const rawSteps = input.steps as PlanStep[] | undefined
        const notes = input.notes ? String(input.notes) : ''

        if (!planId) return { output: 'Error: plan_id is required.', isError: true }
        if (!title) return { output: 'Error: title is required.', isError: true }
        if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
            return { output: 'Error: steps must be a non-empty array.', isError: true }
        }

        const filename = `.${planId}.plan.md`
        const validation = validatePath(filename)
        if (!validation.ok) return { output: validation.error, isError: true }

        const resolved = path.resolve(filename)

        // Build Markdown content
        const lines: string[] = [
            `# ${title}`,
            '',
            '## Steps',
            '',
        ]

        for (const step of rawSteps) {
            const desc = String(step.description ?? '(no description)')
            const status = STATUS_MAP[step.status] ?? STATUS_MAP.pending
            lines.push(`- ${status} ${desc}`)
        }

        if (notes) {
            lines.push('', '## Notes', '', notes)
        }

        lines.push('') // trailing newline
        const content = lines.join('\n')

        try {
            await fs.writeFile(resolved, content, 'utf-8')
            const done = rawSteps.filter((s) => s.status === 'done').length
            const total = rawSteps.length
            return {
                output:
                    `Plan updated: ${resolved}\n` +
                    `Progress: ${done}/${total} steps done.`,
            }
        } catch (err) {
            return {
                output: `update_plan failed: ${(err as Error).message}`,
                isError: true,
            }
        }
    },
}
