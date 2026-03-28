/**
 * @file 输出区组件 — 渲染对话时间线。
 *
 * Phase 8：显示用户消息、助手回答、工具调用状态、系统通知。
 */

import React from 'react'
import { Box, Text } from 'ink'

// ─── 时间线条目类型 ─────────────────────────────────────────────────────────

/** 用户消息。 */
export type UserEntry = {
    type: 'user'
    text: string
}

/** 助手消息。 */
export type AssistantEntry = {
    type: 'assistant'
    text: string
}

/** 工具调用记录。 */
export type ToolEntry = {
    type: 'tool'
    name: string
    status: 'running' | 'done' | 'error'
    observation?: string
}

/** 系统通知。 */
export type SystemEntry = {
    type: 'system'
    text: string
    tone: 'info' | 'warning' | 'error'
}

/** 时间线条目联合类型。 */
export type TimelineEntry =
    | UserEntry
    | AssistantEntry
    | ToolEntry
    | SystemEntry

// ─── 子组件 ──────────────────────────────────────────────────────────────────

/** 用户消息显示。 */
function UserMessage({ text }: { text: string }) {
    return (
        <Box marginBottom={0}>
            <Text color="green" bold>{'You: '}</Text>
            <Text>{text}</Text>
        </Box>
    )
}

/** 助手消息显示。 */
function AssistantMessage({ text }: { text: string }) {
    return (
        <Box marginBottom={0}>
            <Text color="cyan" bold>{'Assistant: '}</Text>
            <Text>{text}</Text>
        </Box>
    )
}

/** 工具调用状态显示。 */
function ToolStatus({ name, status, observation }: ToolEntry) {
    const icon = status === 'running' ? '⏳' :
                 status === 'done' ? '✅' : '❌'
    const color = status === 'running' ? 'yellow' :
                  status === 'done' ? 'green' : 'red'
    return (
        <Box flexDirection="column" marginLeft={2}>
            <Text color={color}>{`  ${icon} ${name}`}</Text>
            {observation && status !== 'running' && (
                <Box marginLeft={4}>
                    <Text dimColor>
                        {'    📎 '}{observation.slice(0, 120)}
                        {observation.length > 120 ? '...' : ''}
                    </Text>
                </Box>
            )}
        </Box>
    )
}

/** 系统通知显示。 */
function SystemMessage({ text, tone }: { text: string; tone: string }) {
    const color = tone === 'error' ? 'red' :
                  tone === 'warning' ? 'yellow' : 'blue'
    return (
        <Box marginBottom={0}>
            <Text color={color}>{'ℹ️  '}{text}</Text>
        </Box>
    )
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

/** OutputArea Props。 */
export type OutputAreaProps = {
    /** 时间线条目列表。 */
    timeline: TimelineEntry[]
    /** 上下文使用百分比（0-100）。 */
    contextPercent?: number
}

/**
 * 输出区组件。
 *
 * 渲染对话时间线和上下文使用量指示。
 */
export function OutputArea({ timeline, contextPercent }: OutputAreaProps) {
    return (
        <Box flexDirection="column" flexGrow={1}>
            {/* 上下文使用量指示 */}
            {contextPercent !== undefined && contextPercent > 0 && (
                <Box marginBottom={0}>
                    <Text dimColor>
                        {'📊 Context: '}{contextPercent}{'%'}
                        {contextPercent >= 80 ? ' ⚠️' : ''}
                    </Text>
                </Box>
            )}

            {/* 时间线渲染 */}
            {timeline.map((entry, i) => {
                switch (entry.type) {
                    case 'user':
                        return <UserMessage key={i} text={entry.text} />
                    case 'assistant':
                        return <AssistantMessage key={i} text={entry.text} />
                    case 'tool':
                        return <ToolStatus key={i} {...entry} />
                    case 'system':
                        return <SystemMessage key={i} text={entry.text} tone={entry.tone} />
                }
            })}
        </Box>
    )
}
