/**
 * @file 输出区组件 — 渲染对话时间线。
 *
 * Phase 8 升级：TurnCell + StepCell + SystemCell 架构。
 * 使用 Ink <Static> 渲染已完成内容，当前进行中的 Turn 动态渲染。
 */

import React, { memo, useMemo } from 'react'
import { Box, Static, Text } from 'ink'
import { MarkdownRenderer } from './chatwidget/markdown_renderer.js'
import { TOOL_STATUS } from './types.js'
import type {
    SystemMessage,
    StepView,
    ToolStatus,
    TurnView,
} from './types.js'

// ─── 工具函数 ─────────────────────────────────────────────────────────────

function statusColor(status?: ToolStatus): string {
    if (status === TOOL_STATUS.ERROR) return 'red'
    if (status === TOOL_STATUS.EXECUTING) return 'yellow'
    return 'green'
}

function truncate(str: string, max: number): string {
    if (str.length <= max) return str
    return `${str.slice(0, max)}...`
}

/** 提取工具调用的主参数用于显示。 */
function mainParam(input: unknown): string | null {
    if (input === undefined || input === null) return null
    if (typeof input === 'string') return truncate(input, 70)
    if (typeof input !== 'object' || Array.isArray(input)) {
        return truncate(String(input), 70)
    }
    const record = input as Record<string, unknown>
    const keys = ['cmd', 'path', 'file_path', 'query', 'content']
    for (const key of keys) {
        const raw = record[key]
        if (raw === undefined || raw === null || raw === '') continue
        return truncate(String(raw), 70)
    }
    return null
}

// ─── 子组件 ──────────────────────────────────────────────────────────────

/** 系统通知。 */
const SystemCell = memo(function SystemCell({ message }: { message: SystemMessage }) {
    const color = message.tone === 'error' ? 'red'
        : message.tone === 'warning' ? 'yellow' : 'cyan'
    return (
        <Box flexDirection="column">
            <Text color={color}>● {message.title}</Text>
            <Text color="gray">{message.content}</Text>
        </Box>
    )
})

/** 单步：思考 + 工具调用。 */
const StepCell = memo(function StepCell({
    step,
    isCompleted,
}: {
    step: StepView
    isCompleted?: boolean
}) {
    const param = step.action ? mainParam(step.action.input) : null
    return (
        <Box flexDirection="column">
            {step.thinking ? (
                <Box>
                    <Text color="gray">● </Text>
                    <Text color="gray">{truncate(step.thinking, 120)}</Text>
                </Box>
            ) : null}
            {step.action ? (
                <Box>
                    <Text color={statusColor(step.toolStatus)}>● </Text>
                    <Text color="gray">Used </Text>
                    <Text color="cyan">{step.action.tool}</Text>
                    {param ? <Text color="gray"> ({param})</Text> : null}
                </Box>
            ) : null}
            {/* Show streaming assistant text (before turn_final) */}
            {!isCompleted && !step.action && step.assistantText ? (
                <Box>
                    <Text color="red">{'>> '}</Text>
                    <Text>{step.assistantText}</Text>
                </Box>
            ) : null}
        </Box>
    )
})

/** 单轮对话。 */
const TurnCell = memo(function TurnCell({ turn }: { turn: TurnView }) {
    const isCompleted = turn.status !== 'running'
    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box marginY={0}>
                <Text bold color="blue">{`>> `}</Text>
                <Text bold>{turn.userInput}</Text>
            </Box>
            {turn.steps.map((step) => (
                <StepCell
                    key={`${turn.index}-${step.index}`}
                    step={step}
                    isCompleted={isCompleted}
                />
            ))}
            {turn.finalText ? (
                <Box marginTop={0}>
                    <Text color="red">{'>> '}</Text>
                    <MarkdownRenderer content={turn.finalText} />
                </Box>
            ) : null}
            {turn.status && turn.status !== 'ok' && turn.status !== 'running' ? (
                <Text color="red">Status: {turn.status}</Text>
            ) : null}
            {turn.errorMessage ? <Text color="red">{turn.errorMessage}</Text> : null}
        </Box>
    )
})

// ─── 静态渲染项 ──────────────────────────────────────────────────────────────


export type OutputAreaProps = {
    turns: TurnView[]
    systemMessages: SystemMessage[]
    cwd?: string
    modelName: string
    toolCount: number
    approvalPolicy: string
}

type HeaderStaticItem = { type: 'header'; data: { modelName: string; toolCount: number; approvalPolicy: string; cwd?: string } }
type HistoryStaticItem = SystemMessage | TurnView
type StaticItem = HeaderStaticItem | HistoryStaticItem

function isHeaderItem(item: StaticItem): item is HeaderStaticItem {
    return (item as HeaderStaticItem).type === 'header'
}

function isSystemItem(item: HistoryStaticItem): item is SystemMessage {
    return (item as SystemMessage).id !== undefined
}

export function OutputArea({
    turns,
    systemMessages,
    cwd,
    modelName,
    toolCount,
    approvalPolicy,
}: OutputAreaProps) {
    const { staticItems, activeTurn } = useMemo(() => {
        const completedTurns = turns.filter((t) => t.status !== 'running')
        const inProgress = turns.find((t) => t.status === 'running')

        const headerItem: HeaderStaticItem = {
            type: 'header',
            data: { modelName, toolCount, approvalPolicy, cwd },
        }

        const historyItems: HistoryStaticItem[] = [...systemMessages, ...completedTurns]
        // Sort history by sequence to ensure correct rendering order
        historyItems.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))

        const items: StaticItem[] = [headerItem, ...historyItems]

        return { staticItems: items, activeTurn: inProgress }
    }, [turns, systemMessages, modelName, toolCount, approvalPolicy, cwd])

    return (
        <Box flexDirection="column">
            {/* 静态区：Header、系统消息、已完成的历史对话 */}
            <Static items={staticItems}>
                {(item) => {
                    if (isHeaderItem(item)) {
                        return (
                            <Box
                                key="app-header"
                                borderStyle="round"
                                borderColor="blue"
                                paddingX={1}
                                flexDirection="column"
                                marginBottom={1}
                            >
                                <Text bold>cclin</Text>
                                <Text color="gray">
                                    {item.data.modelName} • Tools: {item.data.toolCount} •{' '}
                                    {item.data.approvalPolicy}
                                </Text>
                                {item.data.cwd && <Text color="gray">cwd: {item.data.cwd}</Text>}
                            </Box>
                        )
                    }

                    if (isSystemItem(item)) {
                        return <SystemCell key={`system-${item.id}`} message={item} />
                    }

                    return <TurnCell key={`turn-${item.index}`} turn={item} />
                }}
            </Static>

            {/* 当前正在进行的 Turn */}
            {activeTurn ? (
                <TurnCell key={`active-${activeTurn.index}`} turn={activeTurn} />
            ) : null}
        </Box>
    )
}
