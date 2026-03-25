/**
 * @file 安全工具函数 — 路径校验、命令分级、敏感文件检测。
 *
 * Phase 3：基础安全机制。
 * Phase 4 将在此基础上增加完整审批流程。
 */

import * as path from 'node:path'

// ─── 敏感文件列表 ─────────────────────────────────────────────────────────────

/** 不应被读写的敏感文件模式。 */
const SENSITIVE_PATTERNS = [
    '.env',
    '.env.local',
    '.env.production',
    'id_rsa',
    'id_ed25519',
    'id_ecdsa',
    '.ssh/config',
    '.npmrc',
    '.pypirc',
    'credentials',
    'shadow',
    'passwd',
]

// ─── 危险命令列表 ─────────────────────────────────────────────────────────────

/** 绝对禁止执行的命令（block 级别）。 */
const BLOCKED_COMMANDS = new Set([
    'rm -rf /',
    'rm -rf ~',
    'rm -rf /*',
    'mkfs',
    'dd if=',
    ':(){:|:&};:',
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    'format',
])

/** 需要用户确认的命令前缀（confirm 级别）。 */
const CONFIRM_PREFIXES = [
    'rm ',
    'rmdir ',
    'del ',
    'rd ',
    'mv ',
    'chmod ',
    'chown ',
    'kill ',
    'pkill ',
]

// ─── 路径校验 ─────────────────────────────────────────────────────────────────

export function validatePath(
    filePath: string,
): { ok: true } | { ok: false; error: string } {
    const normalized = path.normalize(filePath)
    if (normalized.includes('..')) {
        return { ok: false, error: `Path traversal detected: ${filePath}` }
    }
    if (isSensitiveFile(filePath)) {
        return { ok: false, error: `Access to sensitive file denied: ${filePath}` }
    }
    return { ok: true }
}

// ─── 命令分级 ─────────────────────────────────────────────────────────────────

export type CommandSafety = 'safe' | 'confirm' | 'block'

export function classifyCommand(command: string): CommandSafety {
    const trimmed = command.trim().toLowerCase()

    for (const blocked of BLOCKED_COMMANDS) {
        if (trimmed.includes(blocked)) return 'block'
    }
    for (const prefix of CONFIRM_PREFIXES) {
        if (trimmed.startsWith(prefix)) return 'confirm'
    }
    return 'safe'
}

// ─── 敏感文件检测 ──────────────────────────────────────────────────────────────

export function isSensitiveFile(filePath: string): boolean {
    const basename = path.basename(filePath)
    const normalized = filePath.replace(/\\/g, '/')
    return SENSITIVE_PATTERNS.some(
        (pattern) =>
            basename === pattern ||
            normalized.endsWith(`/${pattern}`),
    )
}
