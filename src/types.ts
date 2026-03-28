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
    /** 工具调用：工具名 + 输入参数（第一个工具，保持向后兼容）。 */
    action?: { tool: string; input: unknown }
    /** 所有工具调用列表（Phase 3+，支持多工具并行调用）。 */
    actions?: Array<{ tool: string; input: unknown }>
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
    /** 本步骤的实际工具调用数量。 */
    toolCallCount?: number
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

// ─── Phase 3: 工具系统类型 ──────────────────────────────────────────────────

/** JSON Schema 子集，用于描述工具输入参数。 */
export type ToolInputSchema = {
    type: 'object'
    properties: Record<string, {
        type: string
        description?: string
        items?: { type: string }
        enum?: string[]
        default?: unknown
    }>
    required?: string[]
}

/** 工具执行结果。 */
export type ToolResult = {
    /** 输出文本。 */
    output: string
    /** 是否为错误结果。 */
    isError?: boolean
}

/**
 * 工具定义接口。
 *
 * 每个工具通过此接口描述自身：
 *   - name / description：用于 LLM 理解工具用途
 *   - inputSchema：JSON Schema 描述参数格式
 *   - execute：实际执行逻辑
 *   - isMutating：是否修改外部状态（用于安全分级）
 */
export type ToolDefinition = {
    /** 工具唯一名称。 */
    name: string
    /** 工具描述（给 LLM 阅读）。 */
    description: string
    /** 输入参数的 JSON Schema 描述。 */
    inputSchema: ToolInputSchema
    /** 是否会修改外部状态（文件、进程等）。 */
    isMutating: boolean
    /** 执行工具。 */
    execute: (input: Record<string, unknown>) => Promise<ToolResult>
}

// ─── Phase 4: 审批 & 工具编排类型 ──────────────────────────────────────────────

/** 审批策略：always=每次询问, once=同指纹本轮只问一次, session=整个会话有效。 */
export type ApprovalPolicy = 'always' | 'once' | 'session'

/** 用户审批决定。 */
export type ApprovalDecision = 'approve' | 'deny'

/** 审批检查结果（联合类型）。 */
export type ApprovalCheckResult =
    | { needsApproval: false }
    | {
          needsApproval: true
          fingerprint: string
          reason: string
          toolName: string
          input: unknown
      }

/** 审批请求（传给 UI 回调）。 */
export type ApprovalRequest = {
    toolName: string
    input: unknown
    fingerprint: string
    reason: string
}

/** 审批回调钩子。 */
export type ApprovalHooks = {
    /** 请求用户审批，返回用户决定。 */
    requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>
}

/** 工具调用请求。 */
export type ToolAction = {
    id: string
    name: string
    input: unknown
}

/** 单个工具执行状态。 */
export type ToolActionStatus =
    | 'success'
    | 'approval_denied'
    | 'tool_not_found'
    | 'input_invalid'
    | 'execution_failed'

/** 单个工具执行结果。 */
export type ToolActionResult = {
    actionId: string
    tool: string
    status: ToolActionStatus
    success: boolean
    observation: string
    durationMs: number
}

/** 批量工具执行结果。 */
export type ToolExecutionResult = {
    results: ToolActionResult[]
    combinedObservation: string
    hasRejection: boolean
}

// ─── Phase 6: 上下文压缩类型 ────────────────────────────────────────────────

/** Token 计数器接口。 */
export type TokenCounter = {
    /** 使用的 tokenizer 模型名。 */
    model: string
    /** 计算纯文本的 token 数。 */
    countText: (text: string) => number
    /** 计算消息数组的 token 数（含 ChatML 开销）。 */
    countMessages: (messages: ChatMessage[]) => number
    /** 释放 tokenizer 资源。 */
    dispose: () => void
}

/** 压缩触发原因。 */
export type CompactReason = 'auto' | 'manual'

/** 压缩结果状态。 */
export type CompactStatus = 'success' | 'skipped' | 'failed'

/** 压缩执行结果。 */
export type CompactResult = {
    /** 触发原因。 */
    reason: CompactReason
    /** 执行状态。 */
    status: CompactStatus
    /** 压缩前 token 数。 */
    beforeTokens: number
    /** 压缩后 token 数。 */
    afterTokens: number
    /** 阈值 token 数。 */
    thresholdTokens: number
    /** 缩减百分比。 */
    reductionPercent: number
    /** 生成的摘要文本（成功时）。 */
    summary?: string
    /** 错误信息（失败时）。 */
    errorMessage?: string
}

// ─── Phase 7: Hook / 中间件类型 ─────────────────────────────────────────────

/** 通用 Hook 回调签名（支持同步/异步）。 */
export type AgentHookHandler<Payload> = (payload: Payload) => Promise<void> | void

/** Turn 开始时的 Hook 负载。 */
export type TurnStartHookPayload = {
    sessionId: string
    turn: number
    input: string
    history: ChatMessage[]
}

/** 工具调用（action）时的 Hook 负载。 */
export type ActionHookPayload = {
    sessionId: string
    turn: number
    step: number
    action: { tool: string; input: unknown }
    thinking?: string
    history: ChatMessage[]
}

/** 工具执行结果（observation）的 Hook 负载。 */
export type ObservationHookPayload = {
    sessionId: string
    turn: number
    step: number
    tool: string
    observation: string
    history: ChatMessage[]
}

/** 最终回答的 Hook 负载。 */
export type FinalHookPayload = {
    sessionId: string
    turn: number
    finalText: string
    status: TurnStatus
    steps: AgentStepTrace[]
    turnUsage: Partial<TokenUsage>
}

/** 上下文 token 使用量报告的 Hook 负载。 */
export type ContextUsageHookPayload = {
    sessionId: string
    turn: number
    step: number
    promptTokens: number
    contextWindow: number
    thresholdTokens: number
    usagePercent: number
}

/** 上下文压缩完成的 Hook 负载。 */
export type ContextCompactedHookPayload = {
    sessionId: string
    turn: number
    reason: CompactReason
    status: CompactStatus
    beforeTokens: number
    afterTokens: number
    thresholdTokens: number
    reductionPercent: number
    summary?: string
    errorMessage?: string
}

/** 审批请求发出的 Hook 负载。 */
export type ApprovalHookPayload = {
    sessionId: string
    turn: number
    step: number
    request: ApprovalRequest
}

/** 审批结果返回的 Hook 负载。 */
export type ApprovalResponseHookPayload = {
    sessionId: string
    turn: number
    step: number
    fingerprint: string
    decision: ApprovalDecision
}

/** 标题生成的 Hook 负载（预留）。 */
export type TitleGeneratedHookPayload = {
    sessionId: string
    turn: number
    title: string
    originalPrompt: string
}

/** Hook 集合：一次性注入的生命周期监听器。 */
export type AgentHooks = {
    onTurnStart?: AgentHookHandler<TurnStartHookPayload>
    onAction?: AgentHookHandler<ActionHookPayload>
    onObservation?: AgentHookHandler<ObservationHookPayload>
    onFinal?: AgentHookHandler<FinalHookPayload>
    onContextUsage?: AgentHookHandler<ContextUsageHookPayload>
    onContextCompacted?: AgentHookHandler<ContextCompactedHookPayload>
    onApprovalRequest?: AgentHookHandler<ApprovalHookPayload>
    onApprovalResponse?: AgentHookHandler<ApprovalResponseHookPayload>
    onTitleGenerated?: AgentHookHandler<TitleGeneratedHookPayload>
}

/** 中间件：带可选名称的 Hook 集合，支持批量注册多个。 */
export type AgentMiddleware = AgentHooks & {
    name?: string
}

// ─── Phase 9: 工具路由 & MCP 类型 ────────────────────────────────────────────

/** 工具来源标识。 */
export type ToolSource = 'native' | 'mcp'

/** MCP Server 配置（stdio 传输）。 */
export type MCPServerConfig = {
    /** 启动命令（如 'node', 'npx'）。 */
    command: string
    /** 命令参数列表。 */
    args?: string[]
    /** 环境变量覆盖（会与 process.env 合并）。 */
    env?: Record<string, string>
}

/** MCP 配置文件的完整格式。 */
export type MCPConfigFile = {
    mcpServers?: Record<string, MCPServerConfig>
}

/** MCP 工具定义（继承 ToolDefinition，增加来源信息）。 */
export type McpToolDefinition = ToolDefinition & {
    /** 工具来源。 */
    source: 'mcp'
    /** 所属 MCP Server 名称。 */
    serverName: string
    /** 在 MCP Server 上的原始工具名。 */
    originalName: string
}

/**
 * 工具查询接口（ToolOrchestrator 的依赖抽象）。
 *
 * 让 ToolOrchestrator 同时支持 ToolRegistry 和 ToolRouter。
 */
export type ToolQueryable = {
    /** 根据工具名获取工具定义。 */
    get(name: string): ToolDefinition | undefined
}
