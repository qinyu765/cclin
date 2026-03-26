/**
 * @file 上下文压缩模块 — LLM 驱动的对话历史摘要。
 *
 * Phase 6：当对话历史的 token 数接近上下文窗口限制时，
 * 调用 LLM 对历史生成结构化摘要，替换原始历史以释放空间。
 *
 * 设计参考 memo-code 的 compact_prompt.ts，但做了精简：
 *   - 去掉了"保留最近 N 条 user 消息"的逻辑（简化）
 *   - 保留了消息转文本、摘要检测、历史重建的核心流程
 */

import type { ChatMessage } from '../types.js'

/** 单条消息内容的最大字符数（超出时截断，避免压缩请求本身过大）。 */
const MAX_MESSAGE_CONTENT_CHARS = 4_000

// ─── 压缩提示词 ─────────────────────────────────────────────────────────────

/**
 * 给 LLM 的压缩指令。
 *
 * 这个 prompt 告诉 LLM："你在做一次检查点压缩，
 * 帮下一个 LLM 接手工作"。关键点：
 *   - 保留进展和关键决策
 *   - 保留约束和用户偏好
 *   - 清晰列出后续步骤
 */
export const CONTEXT_COMPACTION_SYSTEM_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`

/**
 * 摘要消息的识别前缀。
 *
 * 压缩后的摘要以这段文字开头，
 * 让后续的压缩轮次能识别"这是之前的摘要，不是原始对话"。
 */
export const CONTEXT_SUMMARY_PREFIX =
    'Another language model started to solve this problem and produced a summary of its thinking process. Use this summary to continue the task without redoing completed work.'

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 截断过长的消息内容。
 *
 * 防止压缩请求本身太大（比如一个工具返回了 10 万字的文件内容）。
 */
function normalizeContent(content: string): string {
    const compact = content.replace(/\r\n/g, '\n').trim()
    if (compact.length <= MAX_MESSAGE_CONTENT_CHARS) {
        return compact
    }
    return `${compact.slice(0, MAX_MESSAGE_CONTENT_CHARS)}...`
}

/**
 * 将单条消息转换为人类可读的文本行。
 *
 * 格式：[index] ROLE (附加信息)\n内容
 * 这个格式让 LLM 能清晰理解对话的结构和顺序。
 */
function messageToTranscriptLine(
    message: ChatMessage,
    index: number,
): string {
    const role = message.role.toUpperCase()
    if (message.role === 'assistant' && message.tool_calls?.length) {
        const toolNames = message.tool_calls
            .map((tc) => tc.function.name)
            .join(', ')
        return `[${index}] ${role} (tool_calls: ${toolNames})\n${normalizeContent(message.content)}`
    }
    if (message.role === 'tool') {
        const toolName = message.name ? ` (${message.name})` : ''
        return `[${index}] ${role}${toolName}\n${normalizeContent(message.content)}`
    }
    return `[${index}] ${role}\n${normalizeContent(message.content)}`
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

/**
 * 判断消息是否为之前压缩生成的摘要。
 *
 * 通过检查 user 消息是否以摘要前缀开头来识别。
 * 压缩时需要跳过已有的摘要，避免"摘要套摘要"。
 */
export function isContextSummaryMessage(message: ChatMessage): boolean {
    if (message.role !== 'user') return false
    return message.content.startsWith(`${CONTEXT_SUMMARY_PREFIX}\n`)
}

/**
 * 构建发给 LLM 的压缩请求（user prompt 部分）。
 *
 * 将整个对话历史转为文本格式，让 LLM 阅读后生成摘要。
 */
export function buildCompactionUserPrompt(
    messages: ChatMessage[],
): string {
    const transcript = messages.length
        ? messages
              .map((msg, i) => messageToTranscriptLine(msg, i))
              .join('\n\n')
        : '(empty)'

    return [
        'Conversation history to summarize:',
        transcript,
        '',
        'Return only the summary body in plain text. Do not add markdown fences.',
    ].join('\n')
}

/**
 * 用压缩摘要重建历史数组。
 *
 * 新历史结构：[system (如有)] + [摘要消息]
 * 这样历史从完整对话变为一条摘要，大幅减少 token 数。
 */
export function buildCompactedHistory(
    systemMessage: ChatMessage | undefined,
    summary: string,
): ChatMessage[] {
    const summaryMessage: ChatMessage = {
        role: 'user',
        content: `${CONTEXT_SUMMARY_PREFIX}\n${summary}`,
    }

    if (systemMessage) {
        return [systemMessage, summaryMessage]
    }
    return [summaryMessage]
}
