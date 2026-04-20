/**
 * @file 配置加载器 — 从 ~/.cclin/config.toml 加载配置。
 *
 * 优先级（从高到低）：
 *   1. 环境变量 (OPENAI_API_KEY, MODEL_NAME 等 — 向下兼容)
 *   2. TOML 配置文件 (~/.cclin/config.toml)
 *   3. 默认值
 *
 * 首次运行时，若配置文件不存在，生成带注释的模板。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseToml } from 'smol-toml'
import { DEFAULT_CONFIG } from './types.js'
import type { CclinConfig, LLMProviderType, ApprovalPolicy } from './types.js'

// ─── Paths ────────────────────────────────────────────────────────────────

/** Resolve the cclin home directory. */
export function getCclinHome(): string {
    return process.env.CCLIN_HOME ?? join(homedir(), '.cclin')
}

/** Resolve the config file path. */
export function getConfigPath(): string {
    return join(getCclinHome(), 'config.toml')
}

// ─── Template ─────────────────────────────────────────────────────────────

const CONFIG_TEMPLATE = `# CCLIN Configuration
# Docs: https://github.com/qinyu765/cclin

[llm]
# Provider: "openai" | "anthropic" | "gemini"
provider = "openai"

# API key (required)
api_key = ""

# Base URL for OpenAI-compatible APIs
# Change for third-party proxies (DeepSeek, NewAPI, etc.)
base_url = "https://api.openai.com/v1"

# Model name
model = "gpt-4o-mini"

[approval]
# Approval policy: "always" | "once" | "session"
policy = "once"

[context]
# Context window size in tokens
window = 128000

# Auto-compact threshold percentage (0-100)
compact_threshold = 80
`

// ─── Loader ───────────────────────────────────────────────────────────────

/**
 * Load configuration from TOML file with env var overrides.
 * Creates a template config file on first run.
 */
export async function loadConfig(): Promise<CclinConfig> {
    const configPath = getConfigPath()
    let fileConfig: Partial<CclinConfig> = {}

    try {
        const raw = await readFile(configPath, 'utf-8')
        const parsed = parseToml(raw) as Record<string, unknown>
        fileConfig = tomlToConfig(parsed)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // Config file doesn't exist — create template
            await ensureConfigDir()
            await writeFile(configPath, CONFIG_TEMPLATE, 'utf-8')
            console.log(`[Config] Created template: ${configPath}`)
        }
        // Parse errors: fall through to defaults
    }

    // Merge: defaults ← file ← env vars
    const config = mergeConfig(DEFAULT_CONFIG, fileConfig)
    return applyEnvOverrides(config)
}

// ─── Internal helpers ─────────────────────────────────────────────────────

async function ensureConfigDir(): Promise<void> {
    await mkdir(getCclinHome(), { recursive: true })
}

/** Parse TOML object into typed config (partial). */
function tomlToConfig(
    raw: Record<string, unknown>,
): Partial<CclinConfig> {
    const result: Partial<CclinConfig> = {}
    const llm = raw.llm as Record<string, unknown> | undefined
    if (llm) {
        result.llm = {
            provider: asString(llm.provider, 'openai') as LLMProviderType,
            api_key: asString(llm.api_key, ''),
            base_url: asString(llm.base_url, DEFAULT_CONFIG.llm.base_url),
            model: asString(llm.model, DEFAULT_CONFIG.llm.model),
        }
    }
    const approval = raw.approval as Record<string, unknown> | undefined
    if (approval) {
        result.approval = {
            policy: asString(approval.policy, 'once') as ApprovalPolicy,
        }
    }
    const context = raw.context as Record<string, unknown> | undefined
    if (context) {
        result.context = {
            window: asNumber(context.window, DEFAULT_CONFIG.context.window),
            compact_threshold: asNumber(
                context.compact_threshold,
                DEFAULT_CONFIG.context.compact_threshold,
            ),
        }
    }
    return result
}

/** Deep merge config objects. */
function mergeConfig(
    base: CclinConfig,
    override: Partial<CclinConfig>,
): CclinConfig {
    return {
        llm: { ...base.llm, ...override.llm },
        approval: { ...base.approval, ...override.approval },
        context: { ...base.context, ...override.context },
    }
}

/** Apply environment variable overrides (backward compat with .env). */
function applyEnvOverrides(config: CclinConfig): CclinConfig {
    const env = process.env
    return {
        llm: {
            ...config.llm,
            api_key: env.OPENAI_API_KEY ?? config.llm.api_key,
            base_url: env.OPENAI_BASE_URL ?? config.llm.base_url,
            model: env.MODEL_NAME ?? config.llm.model,
        },
        approval: config.approval,
        context: config.context,
    }
}

function asString(val: unknown, fallback: string): string {
    return typeof val === 'string' ? val : fallback
}

function asNumber(val: unknown, fallback: number): number {
    return typeof val === 'number' ? val : fallback
}
