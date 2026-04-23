/**
 * @file 中央 Slash 命令注册表。
 *
 * 所有 slash 命令的元数据在此定义一次，所有消费者从此派生：
 *   - InputArea: Tab 补全、↑↓ 选择、描述展示
 *   - App.handleSubmit: 命令路由和处理
 *   - Footer: 帮助文本简写
 *
 * 添加新命令只需在 COMMAND_REGISTRY 中追加一条记录，其余自动更新。
 */

// ─── 类型定义 ──────────────────────────────────────────────────────────────

export type CommandCategory = 'session' | 'config' | 'info' | 'media'

export interface CommandDef {
    /** 规范名称，不含斜杠（如 "compact"） */
    name: string
    /** 带斜杠的完整名称（如 "/compact"） */
    slash: string
    /** 用户可见的简短描述 */
    desc: string
    /** 分类标签 */
    category: CommandCategory
    /** 别名列表（不含斜杠）*/
    aliases?: readonly string[]
    /** 参数占位符，用于帮助显示（如 "[path]"） */
    argsHint?: string
}

// ─── 命令注册表 ────────────────────────────────────────────────────────────

/**
 * 中央命令注册表。
 *
 * 添加命令：在此追加一个 CommandDef 对象。
 * 所有消费者（补全、路由、帮助文本）自动更新，无需修改其他文件。
 */
export const COMMAND_REGISTRY: readonly CommandDef[] = [
    // ── Session 管理 ──────────────────────────────────────────────────────
    {
        name: 'compact',
        slash: '/compact',
        desc: 'Compact context history',
        category: 'session',
    },
    {
        name: 'clear',
        slash: '/clear',
        desc: 'Clear conversation',
        category: 'session',
    },
    // ── 配置 ─────────────────────────────────────────────────────────────
    {
        name: 'model',
        slash: '/model',
        desc: 'Show current model info',
        category: 'config',
    },
    {
        name: 'approve',
        slash: '/approve',
        desc: 'Change approval policy',
        category: 'config',
        argsHint: '[auto|manual|never]',
    },
    // ── 媒体 ─────────────────────────────────────────────────────────────
    {
        name: 'image',
        slash: '/image',
        desc: 'Attach an image file',
        category: 'media',
        argsHint: '[path]',
    },
    // ── 信息 / 退出 ───────────────────────────────────────────────────────
    {
        name: 'exit',
        slash: '/exit',
        desc: 'Exit cclin',
        category: 'info',
        aliases: ['quit', 'q'],
    },
] as const

// ─── 派生数据结构（消费者直接使用）────────────────────────────────────────

/**
 * 规范名称 → CommandDef 的映射（含别名解析）。
 *
 * 用途：O(1) 命令路由。
 *
 * @example
 * const def = COMMAND_MAP.get('compact')     // 通过规范名查找
 * const def = COMMAND_MAP.get('q')           // 通过别名查找
 */
export const COMMAND_MAP: ReadonlyMap<string, CommandDef> = (() => {
    const map = new Map<string, CommandDef>()
    for (const cmd of COMMAND_REGISTRY) {
        map.set(cmd.name, cmd)
        for (const alias of cmd.aliases ?? []) {
            map.set(alias, cmd)
        }
    }
    return map
})()

/**
 * Tab 补全候选列表（带斜杠）。
 *
 * 用途：InputArea 的模糊过滤。
 *
 * @example
 * const suggestions = COMPLETION_CANDIDATES.filter(c => c.slash.startsWith(input))
 */
export const COMPLETION_CANDIDATES: readonly { slash: string; desc: string }[] =
    COMMAND_REGISTRY.map((cmd) => ({ slash: cmd.slash, desc: cmd.desc }))

/**
 * 解析用户输入的 slash 命令，返回规范的 CommandDef。
 *
 * 支持：带/不带斜杠、别名、大小写不敏感。
 *
 * @param raw 原始输入（如 "/compact"、"compact"、"/q"）
 * @returns 规范 CommandDef，找不到则返回 undefined
 */
export function resolveCommand(raw: string): CommandDef | undefined {
    const normalized = raw.trim().toLowerCase().replace(/^\//, '')
    return COMMAND_MAP.get(normalized)
}
