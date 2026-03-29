/**
 * @file 模型能力配置 — 根据模型名推断其支持的特性。
 *
 * 参考 memo-code 的 model_profile.ts，
 * 不同模型支持不同能力（并行工具调用、思考链等）。
 */

import type OpenAI from 'openai'

// ─── 类型 ────────────────────────────────────────────────────────────────────

/** 模型能力画像。 */
export type ModelProfile = {
    /** 是否支持并行工具调用。 */
    supportsParallelToolCalls: boolean
    /** 是否支持 reasoning_content 字段。 */
    supportsReasoningContent: boolean
    /** 上下文窗口大小（token）。 */
    contextWindow: number
    /** 是否是回退配置（无精确匹配）。 */
    isFallback: boolean
}

// ─── 已知模型配置 ─────────────────────────────────────────────────────────────

type ProfileEntry = Omit<ModelProfile, 'isFallback'>

/** 保守的回退配置。 */
const FALLBACK: ProfileEntry = {
    supportsParallelToolCalls: false,
    supportsReasoningContent: false,
    contextWindow: 128_000,
}

/**
 * 已知模型的能力映射。
 * key 为模型名前缀（小写），匹配时取最长前缀。
 */
const KNOWN_PROFILES: Record<string, ProfileEntry> = {
    'gpt-4o': {
        supportsParallelToolCalls: true,
        supportsReasoningContent: false,
        contextWindow: 128_000,
    },
    'gpt-4o-mini': {
        supportsParallelToolCalls: true,
        supportsReasoningContent: false,
        contextWindow: 128_000,
    },
    'deepseek-chat': {
        supportsParallelToolCalls: false,
        supportsReasoningContent: false,
        contextWindow: 64_000,
    },
    'deepseek-reasoner': {
        supportsParallelToolCalls: false,
        supportsReasoningContent: true,
        contextWindow: 64_000,
    },
    'claude': {
        supportsParallelToolCalls: true,
        supportsReasoningContent: false,
        contextWindow: 200_000,
    },
}

// ─── 解析函数 ─────────────────────────────────────────────────────────────────

/**
 * 根据模型名解析能力配置。
 * 使用最长前缀匹配策略。
 */
export function resolveModelProfile(model: string): ModelProfile {
    const slug = model.trim().toLowerCase()

    // 精确匹配
    if (KNOWN_PROFILES[slug]) {
        return { ...KNOWN_PROFILES[slug], isFallback: false }
    }

    // 前缀匹配（取最长匹配）
    let bestKey = ''
    for (const key of Object.keys(KNOWN_PROFILES)) {
        if (slug.startsWith(key) && key.length > bestKey.length) {
            bestKey = key
        }
    }

    if (bestKey) {
        return { ...KNOWN_PROFILES[bestKey], isFallback: false }
    }

    return { ...FALLBACK, isFallback: true }
}

// ─── 请求构建 ─────────────────────────────────────────────────────────────────

type ToolSpec = {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: Record<string, unknown>
    }
}

/**
 * 根据模型 profile 构建 chat completion 请求参数。
 */
export function buildChatCompletionRequest(params: {
    model: string
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
    tools?: ToolSpec[]
    profile: ModelProfile
}): OpenAI.Chat.Completions.ChatCompletionCreateParams {
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
        model: params.model,
        messages: params.messages,
    }

    if (params.tools && params.tools.length > 0) {
        request.tools = params.tools
        request.tool_choice = 'auto'

        if (params.profile.supportsParallelToolCalls) {
            request.parallel_tool_calls = true
        }
    }

    return request
}
