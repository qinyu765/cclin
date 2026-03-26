/**
 * @file Token 计数器 — 基于 gpt-tokenizer 的本地 token 估算。
 *
 * Phase 6：为上下文压缩提供精确的 token 计数能力。
 *
 * 设计决策：
 *   - 使用 gpt-tokenizer（纯 JS 实现）而非 @dqbd/tiktoken（需要 WASM）
 *   - 按 ChatML 格式估算消息 token（每条消息 +4 overhead）
 *   - 支持 assistant 含 tool_calls 和 reasoning_content 的复杂消息
 */

import { encode } from 'gpt-tokenizer'
import type { ChatMessage, TokenCounter } from '../types.js'

/** 每条消息的 ChatML 包装开销（role + 分隔符）。 */
const TOKENS_PER_MESSAGE = 4

/** 助手回复的起始标记开销。 */
const TOKENS_FOR_ASSISTANT_PRIMING = 2

/**
 * 将 ChatMessage 转换为用于 token 计数的文本负载。
 *
 * 不同 role 的消息结构不同，需要按实际发送给 API 的格式估算：
 *   - assistant：可能含 reasoning_content 和 tool_calls
 *   - tool：包含 tool_call_id 和 name
 *   - system / user：直接取 content
 */
function messagePayloadForCounting(message: ChatMessage): string {
    if (message.role === 'assistant') {
        const reasoning = message.reasoning_content
            ? `\n${message.reasoning_content}`
            : ''
        if (message.tool_calls?.length) {
            return `${message.content}${reasoning}\n${JSON.stringify(message.tool_calls)}`
        }
        return `${message.content}${reasoning}`
    }
    if (message.role === 'tool') {
        return `${message.content}\n${message.tool_call_id}\n${message.name ?? ''}`
    }
    return message.content
}

/**
 * 创建 Token 计数器。
 *
 * 返回的 TokenCounter 对象提供：
 *   - countText：单段文本的 token 数
 *   - countMessages：消息数组的 token 数（含 ChatML 开销）
 *   - dispose：释放资源（当前为空操作，保留接口一致性）
 */
export function createTokenCounter(): TokenCounter {
    const countText = (text: string): number => {
        if (!text) return 0
        return encode(text).length
    }

    const countMessages = (messages: ChatMessage[]): number => {
        if (!messages.length) return 0
        let total = 0
        for (const message of messages) {
            total += TOKENS_PER_MESSAGE
            total += countText(messagePayloadForCounting(message))
        }
        total += TOKENS_FOR_ASSISTANT_PRIMING
        return total
    }

    return {
        model: 'cl100k_base',
        countText,
        countMessages,
        dispose: () => {},
    }
}
