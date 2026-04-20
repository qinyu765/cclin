/**
 * @file LLM Provider 接口 — 多提供商统一抽象。
 *
 * 设计：定义统一的 LLMProvider 接口，使 client.ts 可以基于配置
 * 切换不同后端（OpenAI、Anthropic、Gemini 等），无需修改调用方。
 *
 * 当前实现的 Provider：
 *   - OpenAIProvider（同时支持 OpenAI-compatible API，如 NewAPI/DeepSeek）
 *
 * 后续扩展：
 *   - AnthropicProvider（原生 Anthropic SDK）
 *   - GeminiProvider（Google Generative AI SDK）
 */

import type {
    CallLLM,
    ChatMessage,
} from '../types.js'
import type { LLMProviderType } from '../config/types.js'

// ─── Provider Interface ───────────────────────────────────────────────────

export type ProviderConfig = {
    apiKey: string
    baseURL: string
    model: string
    tools?: Array<{
        type: 'function'
        function: {
            name: string
            description: string
            parameters: Record<string, unknown>
        }
    }>
}

/**
 * LLM Provider 统一接口。
 *
 * 每个 Provider 实现此接口，封装特定 SDK 的调用细节。
 * 调用方只需通过 createProvider() 获取实例，
 * 然后调用 provider.createCallLLM() 获取标准 CallLLM 函数。
 */
export interface LLMProvider {
    /** Provider 名称标识 */
    readonly name: string

    /** 创建绑定配置的 CallLLM 函数 */
    createCallLLM(config: ProviderConfig): CallLLM
}

// ─── Provider Registry ───────────────────────────────────────────────────

const providerRegistry = new Map<string, () => LLMProvider>()

/**
 * Register a provider factory.
 * Called at module initialization time.
 */
export function registerProvider(
    name: string,
    factory: () => LLMProvider,
): void {
    providerRegistry.set(name, factory)
}

/**
 * Create a provider instance by type name.
 * Falls back to 'openai' if the type is not recognized.
 */
export function createProvider(type: LLMProviderType): LLMProvider {
    const factory = providerRegistry.get(type) ?? providerRegistry.get('openai')
    if (!factory) {
        throw new Error(
            `No LLM provider registered for type "${type}". ` +
            `Available: ${[...providerRegistry.keys()].join(', ')}`,
        )
    }
    return factory()
}
