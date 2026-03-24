/**
 * @file cclin agent 核心类型定义。
 *
 * Phase 1：仅包含 LLM 交互类型。
 * 后续阶段将扩展（工具、钩子、会话等）。
 */

// ─── 聊天消息 ─────────────────────────────────────────────────────────────

/** 对话角色。 */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 助手发出的结构化工具调用（OpenAI tool_calls 格式）。 */
export type AssistantToolCall = {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string // JSON 字符串
    }
}

/**
 * 模型侧消息（按 role 区分的联合类型）。
 *
 * 使用 OpenAI chat-completion 消息格式，以便：
 *   1. 可直接通过这些类型构建历史记录数组。
 *   2. 以最少的映射转换为 OpenAI SDK 参数。
 */
export type ChatMessage =
    | {
          role: 'system'
          content: string
      }
    | {
          role: 'user'
          content: string
      }
    | {
          role: 'assistant'
          content: string
          /** DeepSeek 思考链（保留用于后续轮次）。 */
          reasoning_content?: string
          /** 结构化工具调用列表（如有）。 */
          tool_calls?: AssistantToolCall[]
      }
    | {
          role: 'tool'
          content: string
          /** 对应 assistant.tool_calls[*].id。 */
          tool_call_id: string
          /** 工具名称（用于调试）。 */
          name?: string
      }

// ─── LLM 响应 ───────────────────────────────────────────────────────────────

/** Token 用量统计。 */
export type TokenUsage = {
    prompt: number
    completion: number
    total: number
}

/** 文本内容块。 */
export type TextBlock = {
    type: 'text'
    text: string
}

/** 工具调用请求块。 */
export type ToolUseBlock = {
    type: 'tool_use'
    id: string
    name: string
    input: unknown
}

/** LLM 响应中的内容块。 */
export type ContentBlock = TextBlock | ToolUseBlock

/** 结构化的 LLM 响应。 */
export type LLMResponse = {
    content: ContentBlock[]
    reasoning_content?: string
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
    usage?: Partial<TokenUsage>
}

// ─── CallLLM 签名 ──────────────────────────────────────────────────────────

/**
 * LLM 调用函数签名。
 *
 * 接收对话历史，返回结构化响应。
 * `onChunk` 保留用于后续流式支持。
 */
export type CallLLM = (
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
) => Promise<LLMResponse>

// ─── Phase 2: ReAct 循环类型 ────────────────────────────────────────────────

/**
 * 解析后的助手响应（action / final 二选一）。
 *
 * - `action`：工具调用请求，包含工具名和输入参数。
 * - `final`：最终文本回答。
 * - `thinking`：思考内容（当 action/final 混合了思考文本时）。
 */
export type ParsedAssistant = {
    /** 工具调用：工具名 + 输入参数。 */
    action?: { tool: string; input: unknown }
    /** 最终回答文本。 */
    final?: string
    /** 思考内容（混合输出时提取）。 */
    thinking?: string
}

/**
 * 单步调试记录，用于回放和可观测性。
 *
 * 每次 LLM 调用 → 解析 → 工具执行为一个 step。
 */
export type AgentStepTrace = {
    /** 步骤索引，从 0 开始。 */
    index: number
    /** LLM 原始输出文本。 */
    assistantText: string
    /** 解析后的 action/final 结构。 */
    parsed: ParsedAssistant
    /** 工具执行结果（如有）。 */
    observation?: string
    /** 本步骤 token 统计。 */
    tokenUsage?: Partial<TokenUsage>
}

/** 单轮对话的状态码。 */
export type TurnStatus = 'ok' | 'error' | 'cancelled'

/**
 * 单轮对话的执行结果。
 *
 * 包含最终输出、所有步骤轨迹、状态和 token 统计。
 */
export type TurnResult = {
    /** 最终输出文本。 */
    finalText: string
    /** 步骤轨迹数组。 */
    steps: AgentStepTrace[]
    /** 运行状态。 */
    status: TurnStatus
    /** 错误信息（若有）。 */
    errorMessage?: string
    /** 本轮 token 统计。 */
    tokenUsage?: Partial<TokenUsage>
}

/**
 * 工具执行函数签名。
 *
 * Phase 2 使用 mock 实现，Phase 3 替换为真实工具注册表。
 */
export type ExecuteTool = (
    toolName: string,
    toolInput: unknown,
) => Promise<string>
