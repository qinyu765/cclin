/**
 * @file 输入区组件 — 自定义编辑器 + 审批交互 + 底部状态栏。
 *
 * Phase 8 升级：
 *   - 用 useInput + useState 替代 ink-text-input
 *   - 输入提示符 ❯（蓝紫色）
 *   - 底部 Footer 显示 context%
 *   - 审批 overlay 独立渲染
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import {
    getWrappedCursorLayout,
    insertAtCursor,
    moveCursorLeft,
    moveCursorRight,
    backspaceAtCursor,
} from './composer_input.js'

// ─── Slash Commands ──────────────────────────────────────────────────────

const SLASH_COMMANDS = [
    { name: '/compact', desc: 'Compact context history' },
    { name: '/model', desc: 'Show current model info' },
    { name: '/approve', desc: 'Change approval policy' },
    { name: '/retry', desc: 'Retry last message' },
    { name: '/clear', desc: 'Clear conversation' },
    { name: '/exit', desc: 'Exit cclin' },
] as const

// ─── Props ───────────────────────────────────────────────────────────────

export type InputAreaProps = {
    busy: boolean
    onSubmit: (value: string) => void
    approvalPending?: boolean
    approvalText?: string
    onApproval?: (approved: boolean) => void
    contextPercent?: number
    /** Increments on each LLM activity (chunk, tool call) to reset idle timer. */
    activityTick?: number
}

// ─── 组件 ─────────────────────────────────────────────────────────────────

export function InputArea({
    busy,
    onSubmit,
    approvalPending,
    approvalText,
    onApproval,
    contextPercent = 0,
    activityTick = 0,
}: InputAreaProps) {
    const [editor, setEditor] = useState({ value: '', cursor: 0 })
    const editorRef = useRef(editor)
    const [slashIdx, setSlashIdx] = useState(0)

    const commitEditor = useCallback((next: { value: string; cursor: number }) => {
        editorRef.current = next
        setEditor(next)
    }, [])

    // Compute matching slash command suggestions
    const slashSuggestions = useMemo(() => {
        if (!editor.value.startsWith('/') || editor.value.includes(' ')) return []
        return SLASH_COMMANDS.filter(c => c.name.startsWith(editor.value))
    }, [editor.value])

    const { stdout } = useStdout()

    // 键盘输入处理
    useInput((input, key) => {
        // 审批模式
        if (approvalPending && onApproval) {
            if (input === 'y' || input === 'Y') onApproval(true)
            if (input === 'n' || input === 'N') onApproval(false)
            return
        }

        if (busy) return

        // Tab: accept slash suggestion
        if (key.tab && slashSuggestions.length > 0) {
            const selected = slashSuggestions[slashIdx]
            if (selected) {
                commitEditor({ value: selected.name, cursor: selected.name.length })
                setSlashIdx(0)
            }
            return
        }

        // Arrow up/down in slash suggestion mode
        if (slashSuggestions.length > 0) {
            if (key.upArrow) {
                setSlashIdx(i => Math.max(0, i - 1))
                return
            }
            if (key.downArrow) {
                setSlashIdx(i => Math.min(slashSuggestions.length - 1, i + 1))
                return
            }
        }

        // Enter 提交
        if (key.return) {
            const trimmed = editorRef.current.value.trim()
            if (!trimmed) return
            commitEditor({ value: '', cursor: 0 })
            onSubmit(trimmed)
            return
        }

        // Backspace
        if (key.backspace || key.delete) {
            const current = editorRef.current
            if (current.cursor > 0) {
                commitEditor(backspaceAtCursor(current.value, current.cursor))
            }
            return
        }

        // 左右方向键
        if (key.leftArrow) {
            const current = editorRef.current
            commitEditor({ value: current.value, cursor: moveCursorLeft(current.value, current.cursor) })
            return
        }
        if (key.rightArrow) {
            const current = editorRef.current
            commitEditor({ value: current.value, cursor: moveCursorRight(current.value, current.cursor) })
            return
        }

        // Ctrl+A 行首
        if (key.ctrl && input === 'a') {
            commitEditor({ value: editorRef.current.value, cursor: 0 })
            return
        }
        // Ctrl+E 行尾
        if (key.ctrl && input === 'e') {
            const current = editorRef.current
            commitEditor({ value: current.value, cursor: current.value.length })
            return
        }
        // Ctrl+U 删除到行首
        if (key.ctrl && input === 'u') {
            const current = editorRef.current
            commitEditor({ value: current.value.slice(current.cursor), cursor: 0 })
            return
        }

        // 普通字符输入
        if (input && !key.ctrl && !key.meta) {
            const current = editorRef.current
            commitEditor(insertAtCursor(current.value, current.cursor, input))
        }
    })

    // 审批模式
    if (approvalPending && approvalText) {
        return (
            <Box flexDirection="column" marginTop={1}>
                <Box
                    borderStyle="round"
                    borderColor="yellow"
                    paddingX={1}
                    flexDirection="column"
                >
                    <Text bold color="yellow">⚠️ Action Approval Required</Text>
                    <Box marginY={1} marginLeft={1}>
                        <Text color="white">{approvalText}</Text>
                    </Box>
                    <Box>
                        <Text color="cyan">❯ </Text>
                        <Text>Allow this action? </Text>
                        <Text color="gray">[</Text>
                        <Text color="green" bold>Y</Text>
                        <Text color="gray">/</Text>
                        <Text color="red" bold>n</Text>
                        <Text color="gray">] </Text>
                        <Text color="cyan">▊</Text>
                    </Box>
                </Box>
                <Footer busy={false} contextPercent={contextPercent} approvalPending activityTick={activityTick} />
            </Box>
        )
    }

    // Busy 模式
    if (busy) {
        return (
            <Box flexDirection="column">
                <Box>
                    <Text color="gray">❯ </Text>
                    <Text color="gray">{editor.value}</Text>
                </Box>
                <Footer busy contextPercent={contextPercent} activityTick={activityTick} />
            </Box>
        )
    }

    // 普通输入 — 使用 getWrappedCursorLayout 做终端宽度感知的逐行渲染
    const termWidth = stdout?.columns ?? process.stdout?.columns ?? 80
    // Reserve prompt prefix (2 chars "❯ ") and 1 cell for cursor block
    const contentWidth = Math.max(1, termWidth - 3)
    const wrappedLayout = getWrappedCursorLayout(editor.value, editor.cursor, contentWidth)

    return (
        <Box flexDirection="column">
            {wrappedLayout.lines.map((line, idx) => {
                const isCursorRow = idx === wrappedLayout.row
                const beforeText = isCursorRow
                    ? line.text.slice(0, wrappedLayout.cursorInRow)
                    : line.text
                const afterText = isCursorRow
                    ? line.text.slice(wrappedLayout.cursorInRow)
                    : ''

                return (
                    <Box key={`line-${idx}`}>
                        <Text color="#7C3AED" bold>{idx === 0 ? '❯ ' : '  '}</Text>
                        <Text>{beforeText}</Text>
                        {isCursorRow ? <Text color="cyan">▊</Text> : null}
                        {isCursorRow ? <Text>{afterText}</Text> : null}
                    </Box>
                )
            })}
            {slashSuggestions.length > 0 ? (
                <Box flexDirection="column" marginLeft={2}>
                    {slashSuggestions.map((cmd, i) => (
                        <Box key={cmd.name}>
                            <Text
                                color={i === slashIdx ? 'cyan' : 'gray'}
                                bold={i === slashIdx}
                            >
                                {i === slashIdx ? '▸ ' : '  '}
                                {cmd.name}
                            </Text>
                            <Text color="gray"> — {cmd.desc}</Text>
                        </Box>
                    ))}
                    <Text color="gray" italic>Tab to complete • ↑↓ to select</Text>
                </Box>
            ) : null}
            <Footer busy={false} contextPercent={contextPercent} activityTick={activityTick} />
        </Box>
    )
}

// ─── Footer 子组件 ────────────────────────────────────────────────────────

function Footer({
    busy,
    contextPercent,
    approvalPending = false,
    activityTick = 0,
}: {
    busy: boolean
    contextPercent: number
    approvalPending?: boolean
    activityTick?: number
}) {
    const [elapsed, setElapsed] = useState(0)

    // Reset on busy start or any LLM activity (chunk/action)
    useEffect(() => {
        setElapsed(0)
    }, [busy, activityTick])

    useEffect(() => {
        if (!busy) return
        const id = setInterval(() => setElapsed(s => s + 1), 1000)
        return () => clearInterval(id)
    }, [busy])

    const helpText = approvalPending
        ? 'y allow • n deny'
        : 'Enter send • /compact • exit'

    const timerColor = elapsed >= 30 ? 'red' : elapsed >= 15 ? 'yellow' : 'gray'
    const timerSuffix = elapsed >= 30 ? ' ⚠ stalled?' : ''

    return (
        <Box justifyContent="space-between" marginTop={0}>
            <Box>
                {busy ? (
                    <Text color={timerColor}>
                        Working... ({elapsed}s){timerSuffix}
                    </Text>
                ) : (
                    <Text color="gray">{helpText}</Text>
                )}
            </Box>
            <Text color="gray">context: {contextPercent.toFixed(1)}%</Text>
        </Box>
    )
}
