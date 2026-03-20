/**
 * @file Core type definitions for cclin agent.
 *
 * Phase 1: Only LLM interaction types.
 * Will be extended in later phases (tools, hooks, session, etc.).
 */

// ─── Chat Messages ──────────────────────────────────────────────────────────

/** Conversation role. */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** Structured tool calls from Assistant (OpenAI tool_calls format). */
export type AssistantToolCall = {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string // JSON string
    }
}

/**
 * Model-side messages (discriminated union by role).
 *
 * Uses OpenAI chat-completion message shapes so we can:
 *   1. Build history arrays directly from these types.
 *   2. Convert to OpenAI SDK params with minimal mapping.
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
          /** DeepSeek thinking trace (preserved for follow-up rounds). */
          reasoning_content?: string
          /** Structured tool calls list (if any). */
          tool_calls?: AssistantToolCall[]
      }
    | {
          role: 'tool'
          content: string
          /** Corresponds to assistant.tool_calls[*].id. */
          tool_call_id: string
          /** Tool name (for debugging). */
          name?: string
      }

// ─── LLM Response ───────────────────────────────────────────────────────────

/** Token usage statistics. */
export type TokenUsage = {
    prompt: number
    completion: number
    total: number
}

/** Text content block. */
export type TextBlock = {
    type: 'text'
    text: string
}

/** Tool call request block. */
export type ToolUseBlock = {
    type: 'tool_use'
    id: string
    name: string
    input: unknown
}

/** A content block in the LLM response. */
export type ContentBlock = TextBlock | ToolUseBlock

/** Structured LLM response. */
export type LLMResponse = {
    content: ContentBlock[]
    reasoning_content?: string
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
    usage?: Partial<TokenUsage>
}

// ─── CallLLM Signature ──────────────────────────────────────────────────────

/**
 * LLM call function signature.
 *
 * Takes conversation history, returns a structured response.
 * `onChunk` is reserved for future streaming support.
 */
export type CallLLM = (
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
) => Promise<LLMResponse>
