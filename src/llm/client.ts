/**
 * @file LLM client — wraps OpenAI SDK into the CallLLM interface.
 *
 * Design: Factory function `createCallLLM(config)` returns a `CallLLM`.
 * This makes the LLM dependency injectable and testable.
 */

import OpenAI from 'openai'
import type {
    CallLLM,
    ChatMessage,
    ContentBlock,
    LLMResponse,
} from '../types.js'

// ─── Config ─────────────────────────────────────────────────────────────────

export type LLMClientConfig = {
    apiKey: string
    baseURL: string
    model: string
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Convert our ChatMessage to the OpenAI SDK message format.
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
    // system | user
    return { role: msg.role, content: msg.content }
}

/**
 * Safely parse JSON tool arguments.
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
 * Extract reasoning_content from response (DeepSeek thinking models).
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

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a `CallLLM` function bound to the given config.
 *
 * Usage:
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
        // 1. Convert messages
        const openAIMessages = messages.map(toOpenAIMessage)

        // 2. Call API
        const data = await client.chat.completions.create({
            model: config.model,
            messages: openAIMessages,
        })

        // 3. Parse response
        const choice = data.choices?.[0]
        const message = choice?.message
        const reasoningContent = extractReasoningContent(message)

        const usage = {
            prompt: data.usage?.prompt_tokens,
            completion: data.usage?.completion_tokens,
            total: data.usage?.total_tokens,
        }

        // 4. Build content blocks
        const content: ContentBlock[] = []

        if (message?.tool_calls && message.tool_calls.length > 0) {
            // Has tool calls
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
            // Plain text response
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
