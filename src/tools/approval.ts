/**
 * @file 审批管理器 — 管理工具执行的审批策略和授权缓存。
 *
 * Phase 4：基于工具的 isMutating 属性决定是否需要审批。
 *
 * 设计思路：
 *   1. 非 mutating 工具（read_file / list_directory）→ 自动放行
 *   2. mutating 工具（write_file / bash / edit_file）→ 需要审批
 *   3. 用"指纹"去重，避免重复询问相同操作
 *
 * 三种策略：
 *   - always：每次都询问（最严格）
 *   - once：同指纹本轮只问一次
 *   - session：同指纹整个会话有效
 */

import type {
    ApprovalPolicy,
    ApprovalDecision,
    ApprovalCheckResult,
} from '../types.js'

// ─── 指纹生成 ─────────────────────────────────────────────────────────────────

/**
 * 生成工具调用指纹。
 *
 * 将工具名和输入参数序列化为稳定字符串，用于去重。
 * 使用排序后的 JSON 保证相同参数产生相同指纹。
 */
function stableStringify(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (typeof value !== 'object') return String(value)
    const sorted = Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce(
            (acc, key) => {
                acc[key] = (value as Record<string, unknown>)[key]
                return acc
            },
            {} as Record<string, unknown>,
        )
    return JSON.stringify(sorted)
}

export function generateFingerprint(
    toolName: string,
    input: unknown,
): string {
    return `${toolName}::${stableStringify(input)}`
}

// ─── ApprovalManager 类 ──────────────────────────────────────────────────────

/** ApprovalManager 构造参数。 */
export type ApprovalManagerOptions = {
    /** 审批策略，默认 'once'。 */
    policy?: ApprovalPolicy
}

/**
 * 审批管理器。
 *
 * 管理工具执行权限：
 *   - 检查工具是否需要审批
 *   - 缓存已授权的操作指纹
 *   - 支持按轮次或会话级别的授权生命周期
 */
export class ApprovalManager {
    private readonly policy: ApprovalPolicy

    /** once 级别授权缓存（Turn 结束时清除）。 */
    private onceGrants: Set<string> = new Set()

    /** session 级别授权缓存（Session 结束时清除）。 */
    private sessionGrants: Set<string> = new Set()

    constructor(options: ApprovalManagerOptions = {}) {
        this.policy = options.policy ?? 'once'
    }

    /**
     * 检查工具调用是否需要审批。
     *
     * 非 mutating 工具自动放行；
     * mutating 工具根据策略和缓存决定。
     */
    check(
        toolName: string,
        input: unknown,
        isMutating: boolean,
    ): ApprovalCheckResult {
        // 非 mutating 工具直接放行
        if (!isMutating) {
            return { needsApproval: false }
        }

        const fingerprint = generateFingerprint(toolName, input)

        // 检查缓存
        if (this.isGranted(fingerprint)) {
            return { needsApproval: false }
        }

        return {
            needsApproval: true,
            fingerprint,
            reason: `工具 "${toolName}" 会修改外部状态，需要你的确认。`,
            toolName,
            input,
        }
    }

    /** 记录用户决定。 */
    recordDecision(
        fingerprint: string,
        decision: ApprovalDecision,
    ): void {
        if (decision !== 'approve') return

        if (this.policy === 'once') {
            this.onceGrants.add(fingerprint)
        } else if (this.policy === 'session') {
            this.sessionGrants.add(fingerprint)
        }
        // always 策略不缓存
    }

    /** 检查指纹是否已授权。 */
    isGranted(fingerprint: string): boolean {
        return (
            this.onceGrants.has(fingerprint) ||
            this.sessionGrants.has(fingerprint)
        )
    }

    /** 清除 once 级别授权（Turn 结束时调用）。 */
    clearOnceApprovals(): void {
        this.onceGrants.clear()
    }

    /** 清除所有授权（Session 结束时调用）。 */
    dispose(): void {
        this.onceGrants.clear()
        this.sessionGrants.clear()
    }
}
