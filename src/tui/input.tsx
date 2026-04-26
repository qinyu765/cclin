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
    moveCursorUp,
    moveCursorDown,
    insertNewline,
    deleteToLineStart,
    backspaceAtCursor,
} from './composer_input.js'
import { Spinner } from './spinner.js'
import type { ImageAttachment } from './image-attach.js'
import { cleanupTmpFile, readClipboardImage } from './image-attach.js'

// ─── Slash Commands (从中央注册表导入) ────────────────────────────────────
import { COMPLETION_CANDIDATES } from './commands.js'

// ─── Props ───────────────────────────────────────────────────────────────

export type InputAreaProps = {
    busy: boolean
    onSubmit: (value: string, attachments?: ImageAttachment[]) => void
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
    const [pendingAttachments, setPendingAttachments] = useState<ImageAttachment[]>([])
    const [attachError, setAttachError] = useState<string | null>(null)

    // ── Input history (shell-style ↑/↓ navigation) ──────────────────────
    const historyStack = useRef<string[]>([])
    const historyIndex = useRef(-1)  // -1 = not browsing history
    const savedDraft = useRef('')    // preserves unsaved input when browsing

    const commitEditor = useCallback((next: { value: string; cursor: number }) => {
        editorRef.current = next
        setEditor(next)
    }, [])

    const slashIdxRef = useRef(0)
    const commitSlashIdx = useCallback((next: number | ((i: number) => number)) => {
        const newVal = typeof next === 'function' ? next(slashIdxRef.current) : next
        slashIdxRef.current = newVal
        setSlashIdx(newVal)
    }, [])

    // Compute matching slash command suggestions
    const slashSuggestions = useMemo(() => {
        if (!editor.value.startsWith('/') || editor.value.includes(' ')) return []
        return COMPLETION_CANDIDATES.filter(c => c.slash.startsWith(editor.value))
    }, [editor.value])

    const { stdout } = useStdout()

    // ── Double Ctrl+C to exit ────────────────────────────────────────────
    const ctrlCPendingRef = useRef(false)
    const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [ctrlCHint, setCtrlCHint] = useState(false)

    // 键盘输入处理
    useInput((input, key) => {
        // Ctrl+C: double-press to exit (works even when busy)
        if (key.ctrl && input === 'c') {
            if (ctrlCPendingRef.current) {
                // Second press → exit
                if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current)
                ctrlCPendingRef.current = false
                setCtrlCHint(false)
                onSubmit('/exit')
            } else {
                // First press → show hint, reset after 3s
                ctrlCPendingRef.current = true
                setCtrlCHint(true)
                ctrlCTimerRef.current = setTimeout(() => {
                    ctrlCPendingRef.current = false
                    setCtrlCHint(false)
                }, 3000)
            }
            return
        }

        // Any other key resets Ctrl+C pending state
        if (ctrlCPendingRef.current) {
            ctrlCPendingRef.current = false
            setCtrlCHint(false)
            if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current)
        }

        // 审批模式
        if (approvalPending && onApproval) {
            if (input === 'y' || input === 'Y') onApproval(true)
            if (input === 'n' || input === 'N') onApproval(false)
            return
        }

        if (busy) return

        // Ctrl+V (macOS/Linux) 或 Alt+V (Windows): 从剪贴板粘贴图片
        if ((key.ctrl && input === 'v') || (key.meta && input === 'v')) {
            setAttachError(null)
            readClipboardImage().then(att => {
                if (att) {
                    setPendingAttachments(prev => [...prev, att])
                } else {
                    setAttachError('No image found in clipboard')
                }
            })
            return
        }

        const termW = stdout?.columns ?? process.stdout?.columns ?? 80
        const contentW = Math.max(1, termW - 3)


        // ESC: clear input (if non-empty)
        if (key.escape) {
            if (editorRef.current.value) {
                commitEditor({ value: '', cursor: 0 })
            }
            return
        }

        // Alt+Enter: insert newline (also Ctrl+J as fallback)
        if ((key.meta && key.return) || (key.ctrl && input === '\n')) {
            const current = editorRef.current
            commitEditor(insertNewline(current.value, current.cursor))
            return
        }

        // Tab: accept slash suggestion
        const getActiveSuggestions = () => {
            const val = editorRef.current.value
            if (!val.startsWith('/') || val.includes(' ')) return []
            return COMPLETION_CANDIDATES.filter(c => c.slash.startsWith(val))
        }
        
        const activeSuggestions = getActiveSuggestions()

        if (key.tab && activeSuggestions.length > 0) {
            const selected = activeSuggestions[slashIdxRef.current]
            if (selected) {
                commitEditor({ value: selected.slash, cursor: selected.slash.length })
                commitSlashIdx(0)
            }
            return
        }

        // Arrow up/down: slash suggestion → history navigation → multiline cursor
        if (key.upArrow) {
            if (activeSuggestions.length > 0) {
                commitSlashIdx(i => Math.max(0, i - 1))
                return
            }
            const current = editorRef.current
            const layout = getWrappedCursorLayout(current.value, current.cursor, contentW)
            if (layout.row <= 0) {
                // Already on first row → browse history backward
                const stack = historyStack.current
                if (stack.length === 0) return
                if (historyIndex.current === -1) {
                    // Entering history: save current draft
                    savedDraft.current = current.value
                    historyIndex.current = stack.length - 1
                } else if (historyIndex.current > 0) {
                    historyIndex.current--
                } else {
                    return // already at oldest entry
                }
                const entry = stack[historyIndex.current] ?? ''
                commitEditor({ value: entry, cursor: entry.length })
            } else {
                commitEditor({ value: current.value, cursor: moveCursorUp(current.value, current.cursor, contentW) })
            }
            return
        }
        if (key.downArrow) {
            if (activeSuggestions.length > 0) {
                commitSlashIdx(i => Math.min(activeSuggestions.length - 1, i + 1))
                return
            }
            const current = editorRef.current
            const layout = getWrappedCursorLayout(current.value, current.cursor, contentW)
            if (layout.row >= layout.lines.length - 1) {
                // Already on last row → browse history forward
                if (historyIndex.current === -1) return // not browsing history
                if (historyIndex.current < historyStack.current.length - 1) {
                    historyIndex.current++
                    const entry = historyStack.current[historyIndex.current] ?? ''
                    commitEditor({ value: entry, cursor: entry.length })
                } else {
                    // Past newest entry → restore draft
                    historyIndex.current = -1
                    const draft = savedDraft.current
                    commitEditor({ value: draft, cursor: draft.length })
                }
            } else {
                commitEditor({ value: current.value, cursor: moveCursorDown(current.value, current.cursor, contentW) })
            }
            return
        }

        // Enter 提交
        if (key.return) {
            const currentVal = editorRef.current.value.trim()


            // If slash suggestions are open, Enter should select and submit the highlighted command
            if (activeSuggestions.length > 0) {
                const selected = activeSuggestions[slashIdxRef.current]
                if (selected) {
                    commitEditor({ value: '', cursor: 0 })
                    onSubmit(selected.slash)
                    commitSlashIdx(0)
                    return
                }
            }

            const trimmed = currentVal
            if (!trimmed && pendingAttachments.length === 0) return
            // Push to input history (skip consecutive duplicates)
            if (trimmed && trimmed !== historyStack.current[historyStack.current.length - 1]) {
                historyStack.current.push(trimmed)
            }
            historyIndex.current = -1
            savedDraft.current = ''
            commitEditor({ value: '', cursor: 0 })
            const atts = pendingAttachments
            setPendingAttachments([])
            setAttachError(null)
            onSubmit(trimmed, atts.length > 0 ? atts : undefined)
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
        // Ctrl+U 删除到当前行首（多行感知）
        if (key.ctrl && input === 'u') {
            const current = editorRef.current
            commitEditor(deleteToLineStart(current.value, current.cursor))
            return
        }

        // 普通字符输入
        if (input && !key.ctrl && !key.meta) {
            // Typing exits history browsing mode
            historyIndex.current = -1
            savedDraft.current = ''
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
                <Footer busy={false} contextPercent={contextPercent} approvalPending activityTick={activityTick} ctrlCHint={ctrlCHint} />
            </Box>
        )
    }

    // Busy 模式
    if (busy) {
        return (
            <Box flexDirection="column">
                <Box>
                    <Text color="cyan"><Spinner name="dna" color="cyan" /> </Text>
                    <Text color="gray">{editor.value}</Text>
                </Box>
                <Footer busy contextPercent={contextPercent} activityTick={activityTick} ctrlCHint={ctrlCHint} />
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
                        <Box key={cmd.slash}>
                            <Text
                                color={i === slashIdx ? 'cyan' : 'gray'}
                                bold={i === slashIdx}
                            >
                                {i === slashIdx ? '▸ ' : '  '}
                                {cmd.slash}
                            </Text>
                            <Text color="gray"> — {cmd.desc}</Text>
                        </Box>
                    ))}
                    <Text color="gray" italic>Tab to complete • ↑↓ to select</Text>
                </Box>
            ) : null}
            {/* 待附加图片列表 */}
            {pendingAttachments.length > 0 ? (
                <Box flexDirection="column" marginLeft={2} marginTop={0}>
                    {pendingAttachments.map((att, i) => (
                        <Box key={att.path}>
                            <Text color="cyan">📎 </Text>
                            <Text color="cyan" bold>[Image #{i + 1}]</Text>
                            <Text color="gray"> {att.filename} ({att.sizeKB} KB)</Text>
                        </Box>
                    ))}
                    <Text color="gray" italic>Image{pendingAttachments.length > 1 ? 's' : ''} will be attached • Enter to send</Text>
                </Box>
            ) : null}
            {/* 附件错误提示 */}
            {attachError ? (
                <Box marginLeft={2}>
                    <Text color="red">⚠ {attachError}</Text>
                </Box>
            ) : null}
            <Footer busy={false} contextPercent={contextPercent} activityTick={activityTick} ctrlCHint={ctrlCHint} />
        </Box>
    )
}

// ─── Footer 子组件 ────────────────────────────────────────────────────────

function Footer({
    busy,
    contextPercent,
    approvalPending = false,
    activityTick = 0,
    ctrlCHint = false,
}: {
    busy: boolean
    contextPercent: number
    approvalPending?: boolean
    activityTick?: number
    ctrlCHint?: boolean
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

    const helpText = ctrlCHint
        ? ''
        : approvalPending
            ? 'y allow • n deny'
            : 'Enter send • Alt+Enter newline • Alt+V image • ↑↓ history • ESC clear'

    const timerColor = elapsed >= 30 ? 'red' : elapsed >= 15 ? 'yellow' : 'gray'
    const timerSuffix = elapsed >= 30 ? ' ⚠ stalled?' : ''

    return (
        <Box justifyContent="space-between" marginTop={0}>
            <Box>
                {ctrlCHint ? (
                    <Text color="yellow">Press Ctrl+C again to exit</Text>
                ) : busy ? (
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
