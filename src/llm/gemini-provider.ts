/**
 * @file Gemini Provider — 原生 Google Generative AI SDK 直连。
 *
 * 使用 @google/generative-ai 直接调用 Gemini API，
 * 将 Google 的消息/工具/流式格式适配到项目统一的 CallLLM 接口。
 *
 * 特性：
 *   - system 消息通过 systemInstruction 传递
 *   - function calling 原生支持
 *   - 流式响应通过 generateContentStream() 实现
 *   - 多模态图片支持（inlineData）
 */

import {
    GoogleGenerativeAI,
    type Content,
    type Part,
    type FunctionDeclarationsTool,
    type FunctionDeclaration,
    SchemaType,
    type FunctionCall,
} from '@google/generative-ai'
import type {
    CallLLM,
    ChatMessage,
    ContentBlock,
    LLMResponse,
} from '../types.js'
import { registerProvider } from './provider.js'
import type { LLMProvider, ProviderConfig } from './provider.js'

// ─── 消息格式转换 ─────────────────────────────────────────────────────────────

/** Extract system instruction from messages. */
function extractSystemInstruction(
    messages: ChatMessage[],
): string | undefined {
    const sys = messages.find((m) => m.role === 'system')
    return sys ? (sys.content as string) : undefined
}

/** Convert ChatMessage[] to Gemini Content[]. */
function toGeminiContents(messages: ChatMessage[]): Content[] {
    const result: Content[] = []

    for (const msg of messages) {
        if (msg.role === 'system') continue

        if (msg.role === 'user') {
            const parts: Part[] = []
            if (typeof msg.content === 'string') {
                parts.push({ text: msg.content })
            } else {
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        parts.push({ text: part.text })
                    } else {
                        const url = part.image_url.url
                        const match = url.match(
                            /^data:(image\/\w+);base64,(.+)$/,
                        )
                        if (match) {
                            parts.push({
                                inlineData: {
                                    mimeType: match[1],
                                    data: match[2],
                                },
                            })
                        }
                    }
                }
            }
            result.push({ role: 'user', parts })
            continue
        }

        if (msg.role === 'assistant') {
            const parts: Part[] = []
            if (msg.content) {
                parts.push({ text: msg.content })
            }
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    parts.push({
                        functionCall: {
                            name: tc.function.name,
                            args: JSON.parse(tc.function.arguments),
                        },
                    })
                }
            }
            result.push({ role: 'model', parts })
            continue
        }

        if (msg.role === 'tool') {
            result.push({
                role: 'function',
                parts: [
                    {
                        functionResponse: {
                            name: msg.name ?? 'unknown',
                            response: { result: msg.content },
                        },
                    },
                ],
            })
        }
    }

    return result
}

// ─── 工具格式转换 ─────────────────────────────────────────────────────────────

/** Map JSON Schema type string to Gemini SchemaType. */
function mapSchemaType(type: string): SchemaType {
    const map: Record<string, SchemaType> = {
        string: SchemaType.STRING,
        number: SchemaType.NUMBER,
        integer: SchemaType.INTEGER,
        boolean: SchemaType.BOOLEAN,
        array: SchemaType.ARRAY,
        object: SchemaType.OBJECT,
    }
    return map[type] ?? SchemaType.STRING
}

/** Convert OpenAI function calling tools → Gemini FunctionDeclarationsTool. */
function toGeminiTools(
    tools?: ProviderConfig['tools'],
): FunctionDeclarationsTool[] | undefined {
    if (!tools || tools.length === 0) return undefined

    const declarations: FunctionDeclaration[] = tools.map((t) => {
        const params = t.function.parameters
        const properties: Record<string, { type: SchemaType; description: string }> = {}
        const props = (params as Record<string, unknown>).properties as
            | Record<string, Record<string, unknown>>
            | undefined

        if (props) {
            for (const [key, val] of Object.entries(props)) {
                properties[key] = {
                    type: mapSchemaType(
                        (val.type as string) ?? 'string',
                    ),
                    description: (val.description as string) ?? '',
                }
            }
        }

        return {
            name: t.function.name,
            description: t.function.description,
            parameters: {
                type: SchemaType.OBJECT,
                properties: properties as unknown as Record<string, FunctionDeclaration>,
                required: (params as Record<string, unknown>)
                    .required as string[] | undefined,
            },
        } as unknown as FunctionDeclaration
    })

    return [{ functionDeclarations: declarations }]
}

// ─── 工厂函数 ──────────────────────────────────────────────────────────────────

/** Extract function calls from Gemini response parts. */
function extractFunctionCalls(parts: Part[]): FunctionCall[] {
    const calls: FunctionCall[] = []
    for (const part of parts) {
        if ('functionCall' in part && part.functionCall) {
            calls.push(part.functionCall)
        }
    }
    return calls
}

/** Generate a unique-ish tool call ID. */
function generateToolCallId(): string {
    return `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function createGeminiCallLLM(config: ProviderConfig): CallLLM {
    const genAI = new GoogleGenerativeAI(config.apiKey)

    return async (messages, onChunk?) => {
        const systemInstruction = extractSystemInstruction(messages)
        const contents = toGeminiContents(messages)
        const geminiTools = toGeminiTools(config.tools)

        const model = genAI.getGenerativeModel({
            model: config.model,
            ...(systemInstruction ? { systemInstruction } : {}),
            ...(geminiTools ? { tools: geminiTools } : {}),
        })

        // ─── 流式模式 ─────────────────────────────────────────
        if (onChunk) {
            const result = await model.generateContentStream({ contents })

            let textContent = ''
            const functionCalls: FunctionCall[] = []

            for await (const chunk of result.stream) {
                const text = chunk.text()
                if (text) {
                    textContent += text
                    onChunk(text)
                }
                // Collect function calls from stream chunks
                const parts = chunk.candidates?.[0]?.content?.parts
                if (parts) {
                    functionCalls.push(...extractFunctionCalls(parts))
                }
            }

            const content: ContentBlock[] = []
            if (functionCalls.length > 0) {
                if (textContent) {
                    content.push({ type: 'text', text: textContent })
                }
                for (const fc of functionCalls) {
                    content.push({
                        type: 'tool_use',
                        id: generateToolCallId(),
                        name: fc.name,
                        input: fc.args,
                    })
                }
            } else {
                content.push({ type: 'text', text: textContent })
            }

            const resp = await result.response
            const usage = resp.usageMetadata
            const hasToolUse = content.some((c) => c.type === 'tool_use')

            return {
                content,
                stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
                usage: {
                    prompt: usage?.promptTokenCount ?? 0,
                    completion: usage?.candidatesTokenCount ?? 0,
                    total: usage?.totalTokenCount ?? 0,
                },
            }
        }

        // ─── 非流式模式 ───────────────────────────────────────
        const result = await model.generateContent({ contents })
        const resp = result.response
        const parts = resp.candidates?.[0]?.content?.parts ?? []
        const functionCalls = extractFunctionCalls(parts)

        const content: ContentBlock[] = []
        const textParts = parts
            .filter((p): p is Part & { text: string } => 'text' in p)
            .map((p) => p.text)
            .join('')

        if (functionCalls.length > 0) {
            if (textParts) {
                content.push({ type: 'text', text: textParts })
            }
            for (const fc of functionCalls) {
                content.push({
                    type: 'tool_use',
                    id: generateToolCallId(),
                    name: fc.name,
                    input: fc.args,
                })
            }
        } else {
            content.push({ type: 'text', text: textParts })
        }

        const usage = resp.usageMetadata
        const hasToolUse = content.some((c) => c.type === 'tool_use')

        return {
            content,
            stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
            usage: {
                prompt: usage?.promptTokenCount ?? 0,
                completion: usage?.candidatesTokenCount ?? 0,
                total: usage?.totalTokenCount ?? 0,
            },
        } satisfies LLMResponse
    }
}

// ─── Gemini Provider ──────────────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
    readonly name = 'gemini'

    createCallLLM(config: ProviderConfig): CallLLM {
        return createGeminiCallLLM(config)
    }
}

// Auto-register on module load
registerProvider('gemini', () => new GeminiProvider())


