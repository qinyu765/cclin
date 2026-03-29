/**
 * @file LLM 客户端 — 将 OpenAI SDK 封装为 CallLLM 接口。
 *
 * 设计：工厂函数 `createCallLLM(config)` 返回一个 `CallLLM`。
 * 这使得 LLM 依赖可注入且可测试。
 */

import OpenAI from 'openai'
import type {
    CallLLM,
    ChatMessage,
    ContentBlock,
    LLMResponse,
} from '../types.js'
import {
    resolveModelProfile,
    buildChatCompletionRequest,
} from '../runtime/model-profile.js'

// ─── 配置 ─────────────────────────────────────────────────────────────────────

export type LLMClientConfig = {
    apiKey: string
    baseURL: string
    model: string
    /** OpenAI function calling tools（可选，Phase 3+）。 */
    tools?: Array<{
        type: 'function'
        function: {
            name: string
            description: string
            parameters: Record<string, unknown>
        }
    }>
}

// ─── 内部工具函数 ───────────────────────────────────────────────────────────────

/**
 * 将 ChatMessage 转换为 OpenAI SDK 消息格式。
 */
function toOpenAIMessage(
    msg: ChatMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    if (msg.role === 'assistant') {
        return {
            role: 'assistant',
            content: msg.content,
            tool_calls: msg.tool_calls?.map((tc) => ({
                id: tc.id,
                type: tc.type,
                function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                },
            })),
        }
    }
    if (msg.role === 'tool') {
        return {
            role: 'tool',
            content: msg.content,
            tool_call_id: msg.tool_call_id,
        }
    }
    // system | user 角色
    return { role: msg.role, content: msg.content }
}

/**
 * 安全地解析工具调用的 JSON 参数。
 */
function parseToolArguments(
    raw: string,
): { ok: true; data: unknown } | { ok: false; error: string } {
    try {
        return { ok: true, data: JSON.parse(raw) }
    } catch (err) {
        return { ok: false, error: (err as Error).message }
    }
}

/**
 * 从响应中提取 reasoning_content（DeepSeek 思考模型）。
 */
function extractReasoningContent(
    message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined,
): string | undefined {
    const raw = (message as { reasoning_content?: unknown } | undefined)
        ?.reasoning_content
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

// ─── 工厂函数 ──────────────────────────────────────────────────────────────────

/**
 * 创建一个绑定指定配置的 `CallLLM` 函数。
 *
 * 用法：
 * ```ts
 * const callLLM = createCallLLM({ apiKey, baseURL, model })
 * const response = await callLLM(messages)
 * ```
 */
export function createCallLLM(config: LLMClientConfig): CallLLM {
    const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
    })

    return async (messages, _onChunk?) => {
        // 1. 转换消息格式
        const openAIMessages = messages.map(toOpenAIMessage)

        // 2. 构建请求（使用 model profile）
        const profile = resolveModelProfile(config.model)
        const requestParams = buildChatCompletionRequest({
            model: config.model,
            messages: openAIMessages,
            tools: config.tools,
            profile,
        })

        const data = await client.chat.completions.create({
            ...requestParams,
            stream: false,
        })

        // 3. 解析响应
        const choice = data.choices?.[0]
        const message = choice?.message
        const reasoningContent = extractReasoningContent(message)

        const usage = {
            prompt: data.usage?.prompt_tokens,
            completion: data.usage?.completion_tokens,
            total: data.usage?.total_tokens,
        }

        // 4. 构建内容块
        const content: ContentBlock[] = []

        if (message?.tool_calls && message.tool_calls.length > 0) {
            // 包含工具调用
            if (message.content) {
                content.push({ type: 'text', text: message.content })
            }
            for (const tc of message.tool_calls) {
                if (tc.type === 'function') {
                    const parsed = parseToolArguments(tc.function.arguments)
                    if (parsed.ok) {
                        content.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.function.name,
                            input: parsed.data,
                        })
                    } else {
                        content.push({
                            type: 'text',
                            text: `[tool parse error] ${parsed.error}`,
                        })
                    }
                }
            }
        } else {
            // 纯文本响应
            const text = message?.content ?? ''
            content.push({ type: 'text', text })
        }

        const hasToolUse = content.some((c) => c.type === 'tool_use')

        const response: LLMResponse = {
            content,
            reasoning_content: reasoningContent,
            stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
            usage,
        }

        return response
    }
}
