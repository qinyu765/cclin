/**
 * @file 主 App 组件 — Ink TUI 入口。
 *
 * Phase 8：将 Hook 事件映射为 UI 状态，组合 OutputArea + InputArea。
 * 核心思路：通过 AgentMiddleware 接收 Hook 事件 → 更新 React 状态 → 重新渲染。
 */

import React, { useState, useCallback, useRef } from 'react'
import { Box, Text, useApp } from 'ink'
import { OutputArea, type TimelineEntry } from './output.js'
import { InputArea } from './input.js'
import type {
    AgentMiddleware,
    ApprovalRequest,
    ApprovalDecision,
} from '../types.js'

// ─── Props ───────────────────────────────────────────────────────────────────

export type AppProps = {
    /** 模型名称（显示用）。 */
    model: string
    /** API Base URL（显示用）。 */
    baseURL: string
    /** 工具数量（显示用）。 */
    toolCount: number
    /** 审批策略（显示用）。 */
    approvalPolicy: string
    /** 提交用户输入的回调。 */
    onSubmit: (input: string) => Promise<void>
    /** 退出回调。 */
    onExit: () => void
    /** 获取当前 TUI 中间件的回调（App 创建后回传给外层）。 */
    onMiddlewareReady: (mw: AgentMiddleware) => void
    /** 获取审批回调的钩子。 */
    onApprovalReady: (
        requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>,
    ) => void
}

// ─── App 组件 ─────────────────────────────────────────────────────────────────

export function App({
    model,
    baseURL,
    toolCount,
    approvalPolicy,
    onSubmit,
    onExit,
    onMiddlewareReady,
    onApprovalReady,
}: AppProps) {
    const { exit } = useApp()

    // UI 状态
    const [timeline, setTimeline] = useState<TimelineEntry[]>([])
    const [busy, setBusy] = useState(false)
    const [contextPercent, setContextPercent] = useState(0)

    // 审批状态
    const [approvalPending, setApprovalPending] = useState(false)
    const [approvalText, setApprovalText] = useState('')
    const approvalResolver = useRef<((d: ApprovalDecision) => void) | null>(null)

    // 添加时间线条目的辅助函数
    const addEntry = useCallback((entry: TimelineEntry) => {
        setTimeline(prev => [...prev, entry])
    }, [])

    // 更新最后一个工具条目状态
    const updateLastTool = useCallback((
        name: string,
        status: 'done' | 'error',
        observation?: string,
    ) => {
        setTimeline(prev => {
            const updated = [...prev]
            for (let i = updated.length - 1; i >= 0; i--) {
                const e = updated[i]!
                if (e.type === 'tool' && e.name === name && e.status === 'running') {
                    updated[i] = { ...e, status, observation }
                    break
                }
            }
            return updated
        })
    }, [])

    // 构建 TUI 中间件（Hook 事件 → UI 状态更新）
    const tuiMiddleware = React.useMemo<AgentMiddleware>(() => ({
        name: 'tui',
        onTurnStart: ({ turn, input }) => {
            setBusy(true)
            addEntry({ type: 'system', text: `── Turn ${turn} ──`, tone: 'info' })
            addEntry({ type: 'user', text: input })
        },
        onAction: ({ action }) => {
            addEntry({ type: 'tool', name: action.tool, status: 'running' })
        },
        onObservation: ({ tool, observation }) => {
            updateLastTool(tool, 'done', observation)
        },
        onFinal: ({ finalText }) => {
            addEntry({ type: 'assistant', text: finalText })
            setBusy(false)
        },
        onContextUsage: ({ usagePercent }) => {
            setContextPercent(usagePercent)
        },
        onContextCompacted: ({ status, beforeTokens, afterTokens, reductionPercent }) => {
            if (status === 'success') {
                addEntry({
                    type: 'system',
                    text: `📦 压缩: ${beforeTokens} → ${afterTokens} tokens (-${reductionPercent}%)`,
                    tone: 'info',
                })
            }
        },
    }), [addEntry, updateLastTool])

    // 审批回调
    const requestApproval = useCallback((req: ApprovalRequest): Promise<ApprovalDecision> => {
        return new Promise(resolve => {
            setApprovalText(`${req.toolName}: ${req.reason}`)
            setApprovalPending(true)
            approvalResolver.current = resolve
        })
    }, [])

    // 组件挂载时注册中间件和审批回调
    React.useEffect(() => {
        onMiddlewareReady(tuiMiddleware)
        onApprovalReady(requestApproval)
    }, [tuiMiddleware, requestApproval, onMiddlewareReady, onApprovalReady])

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
            {/* 标题栏 */}
            <Box marginBottom={1}>
                <Text bold color="cyan">
                    {'🤖 cclin Phase 8'}
                </Text>
                <Text dimColor>
                    {'  '}
                    {`Model: ${model} | Tools: ${toolCount} | Approval: ${approvalPolicy}`}
                </Text>
            </Box>

            {/* 输出区 */}
            <OutputArea
                timeline={timeline}
                contextPercent={contextPercent}
            />

            {/* 分隔线 */}
            <Box marginTop={1}>
                <Text dimColor>{'─'.repeat(60)}</Text>
            </Box>

            {/* 输入区 */}
            <InputArea
                busy={busy}
                onSubmit={handleSubmit}
                approvalPending={approvalPending}
                approvalText={approvalText}
                onApproval={handleApproval}
            />
        </Box>
    )
}
