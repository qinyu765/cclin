/**
 * @file create_skill 工具 — 将当前对话中的知识整理并保存为可复用 Skill。
 *
 * 保存路径：~/.cclin/skills/<name>/SKILL.md
 * 格式：带 YAML frontmatter 的 Markdown，与 skills.ts 的解析逻辑完全兼容。
 *
 * 保存后，下次 pnpm dev 时 loadSkills() 会自动发现并注入 system prompt。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolDefinition } from '../types.js'

/** 获取 cclin 主目录，支持 CCLIN_HOME 环境变量重定向。 */
function getCclinHome(): string {
    return process.env.CCLIN_HOME ?? path.join(os.homedir(), '.cclin')
}

/** 将 skill name 转为安全的目录名（只允许字母、数字、连字符、下划线）。 */
function sanitizeName(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')          // 空格 → 连字符
        .replace(/[^a-z0-9\-_]/g, '') // 移除非法字符
        .replace(/^-+|-+$/g, '')       // 去掉首尾连字符
}

export const createSkillTool: ToolDefinition = {
    name: 'create_skill',
    description:
        'Save a reusable skill to ~/.cclin/skills/<name>/SKILL.md. ' +
        'The skill will be auto-discovered on the next session start and injected into the system prompt. ' +
        'Use this when the user asks to save a solution as a skill, or when you solved a complex, ' +
        'repeatable problem worth preserving for future sessions.',
    inputSchema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description:
                    'Short skill identifier (kebab-case recommended, e.g. "fix-ts-circular-dep"). ' +
                    'Used as the directory name.',
            },
            description: {
                type: 'string',
                description:
                    'One-sentence description of when to use this skill. ' +
                    'This is shown in the Available Skills list to help decide when to apply it.',
            },
            instructions: {
                type: 'string',
                description:
                    'Full Markdown body of the skill — step-by-step instructions, ' +
                    'code examples, caveats, etc.',
            },
        },
        required: ['name', 'description', 'instructions'],
    },
    isMutating: true,

    async execute(input) {
        const rawName = String(input.name ?? '').trim()
        const description = String(input.description ?? '').trim()
        const instructions = String(input.instructions ?? '').trim()

        if (!rawName) return { output: 'Error: name is required.', isError: true }
        if (!description) return { output: 'Error: description is required.', isError: true }
        if (!instructions) return { output: 'Error: instructions is required.', isError: true }

        const safeName = sanitizeName(rawName)
        if (!safeName) {
            return {
                output: `Error: name "${rawName}" is invalid after sanitization. Use letters, numbers, hyphens only.`,
                isError: true,
            }
        }

        // 目标路径：~/.cclin/skills/<name>/SKILL.md
        const skillDir = path.join(getCclinHome(), 'skills', safeName)
        const skillFile = path.join(skillDir, 'SKILL.md')

        // 检查是否已存在（防止覆盖）
        let alreadyExists = false
        try {
            await fs.access(skillFile)
            alreadyExists = true
        } catch {
            // 不存在，正常写入
        }

        // 构造 SKILL.md 内容（YAML frontmatter + Markdown body）
        const content = [
            '---',
            `name: ${safeName}`,
            `description: ${description}`,
            '---',
            '',
            instructions,
            '',
        ].join('\n')

        await fs.mkdir(skillDir, { recursive: true })
        await fs.writeFile(skillFile, content, 'utf-8')

        const notice = alreadyExists ? ' (overwrote existing skill)' : ''
        return {
            output: [
                `Skill saved${notice}: ${skillFile}`,
                `Name: ${safeName}`,
                `Description: ${description}`,
                '',
                'The skill will be available in the next session automatically.',
                'To use it immediately in this session, read the file with read_file.',
            ].join('\n'),
        }
    },
}
