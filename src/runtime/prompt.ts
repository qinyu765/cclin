/**
 * @file Prompt 管理模块 — 模板引擎 + 系统提示词动态组装。
 *
 * Phase 5：实现灵活的系统提示词加载：
 *   1. 读取 prompt.md 模板
 *   2. 渲染变量替换（{{date}}, {{user}}, {{pwd}}）
 *   3. 加载 AGENTS.md（项目级指令）
 *   4. 加载 SOUL.md（用户人格偏好）
 *   5. 组装完整 system prompt
 */

import os from 'node:os'
import { readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── 模板引擎 ────────────────────────────────────────────────────────────────

/** 模板变量匹配正则：{{varName}} */
const TEMPLATE_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g

/**
 * 渲染模板字符串，将 {{key}} 替换为 vars 中的值。
 *
 * 设计决策：使用简单的正则替换而非完整模板引擎，
 * 因为我们只需要少量变量替换，不需要条件/循环等高级特性。
 */
export function renderTemplate(
    template: string,
    vars: Record<string, string>,
): string {
    return template.replace(
        TEMPLATE_PATTERN,
        (_match, key: string) => vars[key] ?? '',
    )
}

// ─── 环境信息 ────────────────────────────────────────────────────────────────

/** 获取当前操作系统用户名。 */
function resolveUsername(): string {
    try {
        return os.userInfo().username
    } catch {
        return process.env.USER ?? process.env.USERNAME ?? 'unknown'
    }
}

// ─── 上下文文件加载 ──────────────────────────────────────────────────────────

/** 文件加载结果。 */
type FileLoadResult = { path: string; content: string } | null

/**
 * 解析 cclin 主目录（存放 SOUL.md 等用户配置）。
 *
 * 优先级：环境变量 CCLIN_HOME > ~/.cclin
 */
function resolveCclinHome(): string {
    const homeDir = os.homedir()
    const configured = process.env.CCLIN_HOME?.trim()
    if (configured) {
        if (configured.startsWith('~/')) {
            return resolve(join(homeDir, configured.slice(2)))
        }
        return resolve(configured)
    }
    return join(homeDir, '.cclin')
}

/**
 * 读取项目根目录的 AGENTS.md。
 *
 * AGENTS.md 包含项目级的开发规范和指令，
 * 加载后会追加到系统提示词末尾。
 */
async function readProjectAgentsMd(
    projectRoot: string,
): Promise<FileLoadResult> {
    const agentsPath = join(projectRoot, 'AGENTS.md')
    try {
        const content = await readFile(agentsPath, 'utf-8')
        if (!content.trim()) return null
        return { path: agentsPath, content }
    } catch {
        return null
    }
}

/**
 * 读取用户人格偏好文件 SOUL.md。
 *
 * SOUL.md 存放在 ~/.cclin/SOUL.md，包含用户的
 * 语言、风格等个性化偏好，属于"软偏好层"。
 */
async function readSoulMd(): Promise<FileLoadResult> {
    const soulPath = join(resolveCclinHome(), 'SOUL.md')
    try {
        const content = await readFile(soulPath, 'utf-8')
        if (!content.trim()) return null
        return { path: soulPath, content }
    } catch {
        return null
    }
}

// ─── Prompt 组装 ─────────────────────────────────────────────────────────────

/** SOUL.md 占位符正则。 */
const SOUL_PLACEHOLDER = /\{\{\s*soul_section\s*\}\}/

/**
 * 将 SOUL.md 内容渲染为带说明的 section。
 *
 * 包含优先级说明：SOUL.md 是"软偏好层"，
 * 不应覆盖安全规则或 AGENTS.md 指令。
 */
function renderSoulSection(soul: { path: string; content: string }): string {
    return `## User Personality (SOUL.md)
Loaded from: ${soul.path}

- Treat as soft preference for tone, style, and behavior.
- Do NOT override safety rules, AGENTS.md, or explicit user instructions.

${soul.content}`
}

/** loadSystemPrompt 的配置参数。 */
export type LoadSystemPromptOptions = {
    /** 项目根目录，默认 process.cwd()。 */
    cwd?: string
    /** 工具的 Markdown 描述文本（对应 {{tools}} 占位符）。 */
    toolsText?: string
}

/**
 * 加载并组装完整的系统提示词。
 *
 * 组装流程：
 *   1. 读取 prompt.md 模板文件
 *   2. 读取 SOUL.md（可选）
 *   3. 渲染模板变量（date, user, pwd, soul_section）
 *   4. 若模板中无 soul 占位符但有 SOUL.md → 追加到末尾
 *   5. 读取 AGENTS.md（可选）→ 追加到末尾
 *   6. 返回组装后的完整 system prompt
 */
export async function loadSystemPrompt(
    options: LoadSystemPromptOptions = {},
): Promise<string> {
    const cwd = options.cwd ?? process.cwd()

    // 1. 定位并读取 prompt.md 模板
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const promptPath = join(moduleDir, 'prompt.md')
    const template = await readFile(promptPath, 'utf-8')

    // 2. 读取 SOUL.md
    const soul = await readSoulMd()
    const soulSection = soul ? renderSoulSection(soul) : ''
    const hasSoulPlaceholder = SOUL_PLACEHOLDER.test(template)

    // 3. 渲染模板变量
    const vars: Record<string, string> = {
        date: new Date().toISOString(),
        user: resolveUsername(),
        pwd: cwd,
        soul_section: soulSection,
        tools: options.toolsText ?? 'No tools available.',
    }
    let prompt = renderTemplate(template, vars)

    // 4. 若模板中没有 soul 占位符，但有 SOUL.md → 追加
    if (!hasSoulPlaceholder && soulSection) {
        prompt = `${prompt}\n\n${soulSection}`
    }

    // 5. 追加 AGENTS.md（放在越后面，优先级越高）
    const agents = await readProjectAgentsMd(cwd)
    if (agents) {
        prompt = `${prompt}\n\n## Project AGENTS.md\nLoaded from: ${agents.path}\n\n${agents.content}`
    }

    return prompt
}
