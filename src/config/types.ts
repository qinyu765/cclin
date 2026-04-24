/**
 * @file 配置类型定义 — CCLIN 全局配置结构。
 *
 * 配置文件路径: ~/.cclin/config.toml (可通过 CCLIN_HOME 覆盖)
 *
 * TOML 格式示例:
 * ```toml
 * [llm]
 * provider = "openai"
 * api_key = "sk-xxx"
 * base_url = "https://api.openai.com/v1"
 * model = "gpt-4o-mini"
 *
 * [approval]
 * policy = "once"  # always | once | session
 *
 * [context]
 * window = 128000
 * compact_threshold = 80
 * ```
 */

// ─── LLM Provider Config ─────────────────────────────────────────────────

export type LLMProviderType = 'openai' | 'anthropic' | 'gemini'

export type LLMConfig = {
    /** Provider type (default: "openai") */
    provider: LLMProviderType
    /** API key for the provider */
    api_key: string
    /** Base URL for OpenAI-compatible APIs */
    base_url: string
    /** Model name */
    model: string
}

// ─── Approval Config ──────────────────────────────────────────────────────

export type ApprovalPolicy = 'always' | 'once' | 'session' | 'auto'

export type ApprovalConfig = {
    /** Default approval policy */
    policy: ApprovalPolicy
}

// ─── Context Config ───────────────────────────────────────────────────────

export type ContextConfig = {
    /** Context window size in tokens */
    window: number
    /** Auto-compact threshold percentage (0-100) */
    compact_threshold: number
}

// ─── Root Config ──────────────────────────────────────────────────────────

export type CclinConfig = {
    llm: LLMConfig
    approval: ApprovalConfig
    context: ContextConfig
}

// ─── Defaults ─────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: CclinConfig = {
    llm: {
        provider: 'openai',
        api_key: '',
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
    },
    approval: {
        policy: 'once',
    },
    context: {
        window: 128_000,
        compact_threshold: 80,
    },
}
