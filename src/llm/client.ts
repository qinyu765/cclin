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
        timeout: 60000, // 60s timeout to prevent infinite API hangs
        maxRetries: 1,  // fail fast
    })

    return async (messages, onChunk?) => {
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

        // ─── 流式模式 ─────────────────────────────────────────────
        if (onChunk) {
            const controller = new AbortController()
            let timeoutId = setTimeout(() => controller.abort(new Error('LLM Stream idle timeout (>60s)')), 60000)
            const resetTimeout = () => {
                clearTimeout(timeoutId)
                timeoutId = setTimeout(() => controller.abort(new Error('LLM Stream idle timeout (>60s)')), 60000)
            }

            let stream
            try {
                stream = await client.chat.completions.create({
                    ...requestParams,
                    stream: true,
                }, { signal: controller.signal })
            } catch (err) {
                clearTimeout(timeoutId)
                throw err
            }

            let textContent = ''
            let reasoningContent = ''
            const toolCallDeltas: Map<number, {
                id: string; name: string; args: string
            }> = new Map()
            let promptTokens = 0
            let completionTokens = 0
            let totalTokens = 0

            try {
                for await (const chunk of stream) {
                    resetTimeout()
                    const delta = chunk.choices?.[0]?.delta

                // 文本 delta
                if (delta?.content) {
                    textContent += delta.content
                    onChunk(delta.content)
                }

                // Reasoning delta (DeepSeek / proxy extensions)
                const rd = (delta as { reasoning_content?: string })
                    ?.reasoning_content
                if (rd) {
                    reasoningContent += rd
                    if (onChunk) onChunk(rd)
                }

                // Tool call deltas（增量拼接）
                if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const existing = toolCallDeltas.get(tc.index)
                        if (existing) {
                            existing.args += tc.function?.arguments ?? ''
                        } else {
                            toolCallDeltas.set(tc.index, {
                                id: tc.id ?? '',
                                name: tc.function?.name ?? '',
                                args: tc.function?.arguments ?? '',
                            })
                        }
                    }
                }

                // Usage（最后一个 chunk 包含）
                if (chunk.usage) {
                    promptTokens = chunk.usage.prompt_tokens ?? 0
                    completionTokens = chunk.usage.completion_tokens ?? 0
                    totalTokens = chunk.usage.total_tokens ?? 0
                }
            }

            // 组装最终响应
            const content: ContentBlock[] = []
            const toolBlocks = Array.from(toolCallDeltas.values())

            if (toolBlocks.length > 0) {
                if (textContent) content.push({ type: 'text', text: textContent })
                for (const tb of toolBlocks) {
                    const parsed = parseToolArguments(tb.args)
                    if (parsed.ok) {
                        content.push({
                            type: 'tool_use',
                            id: tb.id,
                            name: tb.name,
                            input: parsed.data,
                        })
                    } else {
                        content.push({
                            type: 'text',
                            text: `[tool parse error] ${parsed.error}`,
                        })
                    }
                }
            } else {
                content.push({ type: 'text', text: textContent })
            }

            const hasToolUse = content.some(c => c.type === 'tool_use')
            return {
                content,
                reasoning_content: reasoningContent.trim() || undefined,
                stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
                usage: {
                   prompt: promptTokens,
                   completion: completionTokens,
                   total: totalTokens,
               },
            }
            } finally {
                clearTimeout(timeoutId)
            }
        }

        // ─── 非流式模式（向后兼容） ────────────────────────────────
        const data = await client.chat.completions.create({
            ...requestParams,
            stream: false,
        })

        const choice = data.choices?.[0]
        const message = choice?.message
        const reasoningContent = extractReasoningContent(message)

        const usage = {
            prompt: data.usage?.prompt_tokens,
            completion: data.usage?.completion_tokens,
            total: data.usage?.total_tokens,
        }

        const content: ContentBlock[] = []

        if (message?.tool_calls && message.tool_calls.length > 0) {
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
