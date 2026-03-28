/**
 * @file 输入区组件 — 文本输入 + 审批交互。
 *
 * Phase 8：提供用户输入框，支持 busy 状态禁用和审批确认。
 */

import React from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'

// ─── Props ───────────────────────────────────────────────────────────────────

export type InputAreaProps = {
    /** 当前是否正在处理（禁用输入）。 */
    busy: boolean
    /** 提交回调。 */
    onSubmit: (value: string) => void
    /** 是否处于审批模式。 */
    approvalPending?: boolean
    /** 审批信息描述。 */
    approvalText?: string
    /** 审批回调。 */
    onApproval?: (approved: boolean) => void
}

// ─── 组件 ─────────────────────────────────────────────────────────────────────

/**
 * 输入区组件。
 *
 * 两种模式：
 *   1. 普通模式：文本输入框，回车提交
 *   2. 审批模式：显示审批信息，y/n 按键确认
 */
export function InputArea({
    busy,
    onSubmit,
    approvalPending,
    approvalText,
    onApproval,
}: InputAreaProps) {
    const [value, setValue] = React.useState('')

    // 审批模式键盘监听
    useInput((input, _key) => {
        if (!approvalPending || !onApproval) return
        if (input === 'y' || input === 'Y') {
            onApproval(true)
        } else if (input === 'n' || input === 'N') {
            onApproval(false)
        }
    }, { isActive: !!approvalPending })

    // 提交处理
    const handleSubmit = (text: string) => {
        const trimmed = text.trim()
        if (!trimmed) return
        setValue('')
        onSubmit(trimmed)
    }

    // 审批模式
    if (approvalPending && approvalText) {
        return (
            <Box flexDirection="column">
                <Text color="yellow">{'🔐 '}{approvalText}</Text>
                <Text dimColor>{'   按 y 允许, n 拒绝'}</Text>
            </Box>
        )
    }

    // busy 模式
    if (busy) {
        return (
            <Box>
                <Text color="yellow">{'⏳ 思考中...'}</Text>
            </Box>
        )
    }

    // 普通输入模式
    return (
        <Box>
            <Text color="green" bold>{'You: '}</Text>
            <TextInput
                value={value}
                onChange={setValue}
                onSubmit={handleSubmit}
                placeholder="输入消息，或 exit 退出..."
            />
        </Box>
    )
}
