/**
 * @file Anthropic Provider — 原生 Anthropic SDK 直连。
 *
 * 使用 @anthropic-ai/sdk 直接调用 Claude API，
 * 将 Anthropic 的消息/工具/流式格式适配到项目统一的 CallLLM 接口。
 *
 * 特性：
 *   - system 消息通过 SDK 的 system 参数传递（不在 messages 数组中）
 *   - tool_use / tool_result 原生支持
 *   - 流式响应通过 client.messages.stream() 实现
 *   - 多模态图片支持（base64）
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
    CallLLM,
    ChatMessage,
    ContentBlock,
    LLMResponse,
} from '../types.js'
import { registerProvider } from './provider.js'
import type { LLMProvider, ProviderConfig } from './provider.js'

// ─── 消息格式转换 ─────────────────────────────────────────────────────────────

/** Extract system prompt from messages (Anthropic uses a separate system param). */
function extractSystemPrompt(messages: ChatMessage[]): string | undefined {
    const sys = messages.find((m) => m.role === 'system')
    return sys ? (sys.content as string) : undefined
}

/** Convert ChatMessage[] to Anthropic MessageParam[]. */
function toAnthropicMessages(
    messages: ChatMessage[],
): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = []

    for (const msg of messages) {
        if (msg.role === 'system') continue // handled separately

        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                result.push({ role: 'user', content: msg.content })
            } else {
                // Multimodal content
                const parts: Anthropic.ContentBlockParam[] = msg.content.map(
                    (part) => {
                        if (part.type === 'text') {
                            return { type: 'text', text: part.text }
                        }
                        // Image: extract base64 from data URL
                        const url = part.image_url.url
                        const match = url.match(
                            /^data:(image\/\w+);base64,(.+)$/,
                        )
                        if (match) {
                            return {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: match[1] as
                                        | 'image/jpeg'
                                        | 'image/png'
                                        | 'image/gif'
                                        | 'image/webp',
                                    data: match[2],
                                },
                            }
                        }
                        // URL-based image
                        return {
                            type: 'image',
                            source: { type: 'url', url },
                        }
                    },
                )
                result.push({ role: 'user', content: parts })
            }
            continue
        }

        if (msg.role === 'assistant') {
            const content: Anthropic.ContentBlockParam[] = []
            if (msg.content) {
                content.push({ type: 'text', text: msg.content })
            }
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function.name,
                        input: JSON.parse(tc.function.arguments),
                    })
                }
            }
            result.push({
                role: 'assistant',
                content: content.length === 1 && content[0].type === 'text'
                    ? (content[0] as Anthropic.TextBlockParam).text
                    : content,
            })
            continue
        }

        if (msg.role === 'tool') {
            result.push({
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: msg.tool_call_id,
                        content: msg.content,
                    },
                ],
            })
        }
    }

    return result
}

// ─── 工具格式转换 ─────────────────────────────────────────────────────────────

/** Convert OpenAI function calling tools → Anthropic Tool format. */
function toAnthropicTools(
    tools?: ProviderConfig['tools'],
): Anthropic.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
    }))
}

// ─── 工厂函数 ──────────────────────────────────────────────────────────────────

function createAnthropicCallLLM(config: ProviderConfig): CallLLM {
    const client = new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        timeout: 60_000,
        maxRetries: 1,
    })

    const anthropicTools = toAnthropicTools(config.tools)

    return async (messages, onChunk?) => {
        const systemPrompt = extractSystemPrompt(messages)
        const anthropicMessages = toAnthropicMessages(messages)

        const requestParams: Anthropic.MessageCreateParams = {
            model: config.model,
            max_tokens: 8192,
            messages: anthropicMessages,
            ...(systemPrompt ? { system: systemPrompt } : {}),
            ...(anthropicTools ? { tools: anthropicTools } : {}),
        }

        // ─── 流式模式 ─────────────────────────────────────────
        if (onChunk) {
            const stream = client.messages.stream(requestParams)
            let textContent = ''

            stream.on('text', (text) => {
                textContent += text
                onChunk(text)
            })

            const finalMessage = await stream.finalMessage()

            const content: ContentBlock[] = []
            for (const block of finalMessage.content) {
                if (block.type === 'text' && block.text) {
                    content.push({ type: 'text', text: block.text })
                } else if (block.type === 'tool_use') {
                    content.push({
                        type: 'tool_use',
                        id: block.id,
                        name: block.name,
                        input: block.input,
                    })
                }
            }
            if (content.length === 0) {
                content.push({ type: 'text', text: textContent })
            }

            const hasToolUse = content.some((c) => c.type === 'tool_use')
            return {
                content,
                stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
                usage: {
                    prompt: finalMessage.usage.input_tokens,
                    completion: finalMessage.usage.output_tokens,
                    total:
                        finalMessage.usage.input_tokens +
                        finalMessage.usage.output_tokens,
                },
            }
        }

        // ─── 非流式模式 ───────────────────────────────────────
        const response = await client.messages.create({
            ...requestParams,
            stream: false,
        })

        const content: ContentBlock[] = []
        for (const block of response.content) {
            if (block.type === 'text') {
                content.push({ type: 'text', text: block.text })
            } else if (block.type === 'tool_use') {
                content.push({
                    type: 'tool_use',
                    id: block.id,
                    name: block.name,
                    input: block.input,
                })
            }
        }

        const hasToolUse = content.some((c) => c.type === 'tool_use')
        return {
            content,
            stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
            usage: {
                prompt: response.usage.input_tokens,
                completion: response.usage.output_tokens,
                total:
                    response.usage.input_tokens +
                    response.usage.output_tokens,
            },
        } satisfies LLMResponse
    }
}

// ─── Anthropic Provider ───────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
    readonly name = 'anthropic'

    createCallLLM(config: ProviderConfig): CallLLM {
        return createAnthropicCallLLM(config)
    }
}

// Auto-register on module load
registerProvider('anthropic', () => new AnthropicProvider())

