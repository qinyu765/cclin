/**
 * @file 主 App 组件 — Ink TUI 入口。
 *
 * Phase 8 升级：useReducer 状态管理 + dispatch actions。
 * 核心思路：通过 AgentMiddleware 接收 Hook 事件 → dispatch action → 重新渲染。
 */

import React, { useCallback, useReducer, useRef } from 'react'
import { Box, Text, useApp } from 'ink'
import { OutputArea } from './output.js'
import { InputArea } from './input.js'
import {
    chatTimelineReducer,
    createInitialState,
} from './state/chat_timeline.js'
import { TOOL_STATUS } from './types.js'
import type { ChatTimelineAction } from './state/chat_timeline.js'
import type {
    AgentMiddleware,
    ApprovalRequest,
    ApprovalDecision,
} from '../types.js'

// ─── Props ───────────────────────────────────────────────────────────────

export type AppProps = {
    /** 当前使用的模型名称，用于 Header 展示 */
    model: string
    /** OpenAI 兼容 API 的 base URL */
    baseURL: string
    /** 已注册工具的数量，用于 Header 展示 */
    toolCount: number
    /** 工具审批策略（如 "auto" / "manual"），用于 Header 展示 */
    approvalPolicy: string
    /** 当前工作目录，用于 Header 展示 */
    cwd: string
    /** 用户提交输入时的处理函数（由 Session 提供） */
    onSubmit: (input: string) => Promise<void>
    /** 用户输入 "exit" 时触发，用于通知外层清理资源 */
    onExit: () => void
    /** TUI 中间件就绪时的回调，将中间件注册到 Session */
    onMiddlewareReady: (mw: AgentMiddleware) => void
    /** 审批回调就绪时的回调，将 requestApproval 函数注入 Session */
    onApprovalReady: (
        requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>,
    ) => void
    /** 流式 chunk 处理器就绪时的回调，用于接收 assistant 增量文本 */
    onAssistantChunkReady: (
        handler: (step: number, chunk: string) => void,
    ) => void
}

// ─── App 组件 ─────────────────────────────────────────────────────────────

export function App({
    model,
    baseURL,
    toolCount,
    approvalPolicy,
    cwd,
    onSubmit,
    onExit,
    onMiddlewareReady,
    onApprovalReady,
    onAssistantChunkReady,
}: AppProps) {
    const { exit } = useApp()

    // useReducer 状态管理
    const [timeline, dispatchTimeline] = useReducer(
        chatTimelineReducer,
        undefined,
        createInitialState,
    )

    const [busy, setBusy] = React.useState(false)
    const [contextPercent, setContextPercent] = React.useState(0)
    const [activityTick, setActivityTick] = React.useState(0)

    // 审批状态
    const [approvalPending, setApprovalPending] = React.useState(false)
    const [approvalText, setApprovalText] = React.useState('')
    const approvalResolver = useRef<((d: ApprovalDecision) => void) | null>(null)
    const currentTurnRef = useRef(0)

    const dispatch = useCallback((action: ChatTimelineAction) => {
        dispatchTimeline(action)
    }, [])

    // 构建 TUI 中间件（Hook 事件 → dispatch actions）
    const tuiMiddleware = React.useMemo<AgentMiddleware>(() => ({
        name: 'tui',
        onTurnStart: ({ turn, input }) => {
            setBusy(true)
            currentTurnRef.current = turn
            dispatch({ type: 'turn_start', turn, input })
        },
        onAction: ({ turn, step, action, thinking }) => {
            setActivityTick(t => t + 1)
            dispatch({
                type: 'tool_action',
                turn,
                step,
                action: { tool: action.tool, input: action.input },
                thinking,
            })
        },
        onObservation: ({ turn, step, tool, observation }) => {
            dispatch({
                type: 'tool_observation',
                turn,
                step,
                observation,
                toolStatus: TOOL_STATUS.SUCCESS,
            })
        },
        onFinal: ({ turn, finalText, status }) => {
            dispatch({
                type: 'turn_final',
                turn,
                finalText,
                status,
            })
            setBusy(false)
        },
        onContextUsage: ({ usagePercent }) => {
            setContextPercent(usagePercent)
        },
        onContextCompacted: ({ status, beforeTokens, afterTokens, reductionPercent }) => {
            if (status === 'success') {
                dispatch({
                    type: 'append_system_message',
                    title: 'Context compacted',
                    content: `${beforeTokens} → ${afterTokens} tokens (-${reductionPercent}%)`,
                })
            }
        },
    }), [dispatch])

    // 审批回调
    const requestApproval = useCallback((req: ApprovalRequest): Promise<ApprovalDecision> => {
        return new Promise(resolve => {
            setApprovalText(`${req.toolName}: ${req.reason}`)
            setApprovalPending(true)
            approvalResolver.current = resolve
        })
    }, [])

    // 组件挂载时注册中间件、审批回调和流式回调
    React.useEffect(() => {
        onMiddlewareReady(tuiMiddleware)
        onApprovalReady(requestApproval)
        onAssistantChunkReady((step, chunk) => {
            setActivityTick(t => t + 1)
            dispatch({
                type: 'assistant_chunk',
                turn: currentTurnRef.current,
                step,
                chunk,
            })
        })
    }, [tuiMiddleware, requestApproval, onMiddlewareReady, onApprovalReady, onAssistantChunkReady, dispatch])

    // 审批响应处理
    const handleApproval = useCallback((approved: boolean) => {
        if (approvalResolver.current) {
            approvalResolver.current(approved ? 'approve' : 'deny')
            approvalResolver.current = null
        }
        setApprovalPending(false)
        setApprovalText('')
    }, [])

    // 提交处理
    const handleSubmit = useCallback(async (input: string) => {
        if (input.toLowerCase() === 'exit') {
            onExit()
            exit()
            return
        }
        await onSubmit(input)
    }, [onSubmit, onExit, exit])

    return (
        <Box flexDirection="column" padding={1}>
            {/* 历史输出与头部静态区 */}
            <OutputArea
                turns={timeline.turns}
                systemMessages={timeline.systemMessages}
                modelName={model}
                toolCount={toolCount}
                approvalPolicy={approvalPolicy}
                cwd={cwd}
            />

            {/* 输入区 */}
            <InputArea
                busy={busy}
                onSubmit={handleSubmit}
                approvalPending={approvalPending}
                approvalText={approvalText}
                onApproval={handleApproval}
                contextPercent={contextPercent}
                activityTick={activityTick}
            />
        </Box>
    )
}
