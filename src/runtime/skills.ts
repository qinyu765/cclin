/**
 * @file Skills 系统 — 技能发现、YAML frontmatter 解析、prompt 注入。
 *
 * Phase 10：让 Agent 能发现和使用项目/用户级 SKILL.md 文件。
 *   1. 扫描搜索根（项目 .agents/skills/ + 用户 ~/.cclin/skills/）
 *   2. 解析 SKILL.md 的 YAML frontmatter（name + description）
 *   3. 渲染 skills section 注入系统提示词
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────────────

export type SkillMetadata = {
    name: string
    description: string
    path: string
}

type LoadSkillsOptions = {
    cwd?: string
    homeDir?: string
    cclinHome?: string
    maxSkills?: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SKILL_FILENAME = 'SKILL.md'
const MAX_SCAN_DEPTH = 4
const DEFAULT_MAX_SKILLS = 100
const MAX_NAME_LEN = 64
const MAX_DESCRIPTION_LEN = 1024

const SKILLS_USAGE_RULES = `### How to use skills
- If the user names a skill or the task clearly matches a skill's description, use that skill.
- To use a skill: open its \`SKILL.md\` with read_file, follow the instructions inside.
- If \`SKILL.md\` references relative paths, resolve them relative to the skill directory.
- Keep context small: only load files directly needed, don't bulk-load everything.
- When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.`

// ─── Frontmatter Parsing ─────────────────────────────────────────────────────

/**
 * 从 Markdown 内容中提取 YAML frontmatter 块。
 * frontmatter 必须以 `---` 开头和结尾。
 */
function extractFrontmatter(content: string): string | null {
    const lines = content.split(/\r?\n/)
    if (lines[0]?.trim() !== '---') return null

    const fmLines: string[] = []
    let foundClosing = false
    for (const line of lines.slice(1)) {
        if (line.trim() === '---') { foundClosing = true; break }
        fmLines.push(line)
    }

    if (!foundClosing || fmLines.length === 0) return null
    return fmLines.join('\n')
}

/**
 * 从 frontmatter 中解析指定 key 的单行值。
 * 支持带/不带引号的值：`name: "foo"` 或 `name: foo`
 */
function parseFrontmatterValue(fm: string, key: string): string | null {
    const pattern = new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, 'm')
    const match = fm.match(pattern)
    if (!match?.[1]) return null

    let val = match[1].trim()
    // Strip quotes
    if (val.length >= 2 &&
        ((val.startsWith('"') && val.endsWith('"')) ||
         (val.startsWith("'") && val.endsWith("'")))) {
        val = val.slice(1, -1)
    }
    return val.split(/\s+/).join(' ') // normalize whitespace
}

/**
 * 解析 SKILL.md 文件内容，提取 name 和 description。
 * 返回 SkillMetadata 或 null（解析失败时）。
 */
export function parseSkillFile(
    content: string,
    path: string,
): SkillMetadata | null {
    const fm = extractFrontmatter(content)
    if (!fm) return null

    const name = parseFrontmatterValue(fm, 'name')
    const description = parseFrontmatterValue(fm, 'description')
    if (!name || !description) return null
    if (name.length > MAX_NAME_LEN || description.length > MAX_DESCRIPTION_LEN) {
        return null
    }

    return { name, description, path }
}

// ─── Skill Discovery ─────────────────────────────────────────────────────────

/** Directories to skip during recursive scanning. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__'])

/**
 * Recursively scan a directory for SKILL.md files.
 * Depth-limited to avoid scanning deeply nested directories.
 */
async function scanDirectory(
    dir: string,
    depth: number,
    results: SkillMetadata[],
    maxSkills: number,
    seenPaths: Set<string>,
): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || results.length >= maxSkills) return

    let entries: import('node:fs').Dirent[]
    try {
        entries = await readdir(dir, {
            withFileTypes: true,
            encoding: 'utf-8',
        }) as import('node:fs').Dirent[]
    } catch {
        return // directory not readable
    }

    for (const entry of entries) {
        if (results.length >= maxSkills) return
        const fullPath = join(dir, entry.name)

        if (entry.isFile() && entry.name === SKILL_FILENAME) {
            const normalizedPath = resolve(fullPath)
            if (seenPaths.has(normalizedPath)) continue

            try {
                const content = await readFile(normalizedPath, 'utf-8')
                const parsed = parseSkillFile(content, normalizedPath)
                if (parsed) {
                    results.push(parsed)
                    seenPaths.add(normalizedPath)
                }
            } catch {
                continue // file not readable
            }
        } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
            await scanDirectory(fullPath, depth + 1, results, maxSkills, seenPaths)
        }
    }
}

/**
 * Resolve the skill root directories to scan.
 *   1. Project-level: <cwd>/.agents/skills/
 *   2. User-level: ~/.cclin/skills/
 */
function resolveSkillRoots(options: LoadSkillsOptions): string[] {
    const cwd = options.cwd ?? process.cwd()
    const home = options.homeDir ?? homedir()
    const cclinHome = options.cclinHome
        ?? process.env.CCLIN_HOME
        ?? join(home, '.cclin')

    return [
        join(cwd, '.agents', 'skills'),
        join(cclinHome, 'skills'),
    ]
}

/**
 * 加载所有可用的 Skills。
 * 扫描项目级和用户级目录，发现并解析 SKILL.md 文件。
 */
export async function loadSkills(
    options: LoadSkillsOptions = {},
): Promise<SkillMetadata[]> {
    const roots = resolveSkillRoots(options)
    const maxSkills = Math.max(1, options.maxSkills ?? DEFAULT_MAX_SKILLS)
    const skills: SkillMetadata[] = []
    const seenPaths = new Set<string>()

    for (const root of roots) {
        // Check if root directory exists before scanning
        try {
            const info = await stat(root)
            if (!info.isDirectory()) continue
        } catch {
            continue // root doesn't exist
        }

        await scanDirectory(root, 0, skills, maxSkills, seenPaths)
    }

    return skills
}

// ─── Prompt Rendering ────────────────────────────────────────────────────────

/**
 * 将 skills 列表渲染为可注入 system prompt 的文本。
 * 如果没有 skills 则返回 null。
 */
export function renderSkillsSection(
    skills: SkillMetadata[],
): string | null {
    if (skills.length === 0) return null

    const lines: string[] = []
    lines.push('## Skills')
    lines.push(
        'A skill is a set of local instructions stored in a `SKILL.md` file. '
        + 'Below is the list of available skills.',
    )
    lines.push('')
    lines.push('### Available skills')
    for (const skill of skills) {
        lines.push(`- **${skill.name}**: ${skill.description} (file: ${skill.path})`)
    }
    lines.push('')
    lines.push(SKILLS_USAGE_RULES)
    return lines.join('\n')
}
