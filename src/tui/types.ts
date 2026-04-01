/**
 * @file TUI 专用视图类型 — 与 runtime types 解耦。
 *
 * 这些类型仅用于 UI 渲染层，不影响 runtime 逻辑。
 * 参考 memo-code/packages/tui/src/types.ts 设计。
 */

// ─── 工具状态 ─────────────────────────────────────────────────────────────

export const TOOL_STATUS = {
    PENDING: 'pending',
    EXECUTING: 'executing',
    SUCCESS: 'success',
    ERROR: 'error',
} as const

export type ToolStatus = (typeof TOOL_STATUS)[keyof typeof TOOL_STATUS]

// ─── 工具动作 ─────────────────────────────────────────────────────────────

export type ToolAction = {
    tool: string
    input: unknown
}

// ─── 步骤视图 ─────────────────────────────────────────────────────────────

/** 单步视图（一次 LLM → 工具调用周期）。 */
export type StepView = {
    index: number
    assistantText: string
    thinking?: string
    action?: ToolAction
    observation?: string
    toolStatus?: ToolStatus
}

// ─── 轮次视图 ─────────────────────────────────────────────────────────────

/** 单轮对话视图。 */
export type TurnView = {
    index: number
    userInput: string
    steps: StepView[]
    status?: 'running' | 'ok' | 'error' | 'cancelled'
    errorMessage?: string
    finalText?: string
    sequence?: number
}

// ─── 系统消息 ─────────────────────────────────────────────────────────────

export type SystemMessageTone = 'info' | 'warning' | 'error'

export type SystemMessage = {
    id: string
    title: string
    content: string
    sequence: number
    tone?: SystemMessageTone
}
