/**
 * @file ReAct 循环核心引擎。
 *
 * Phase 2：实现 Think → Act → Observe 循环骨架。
 * 工具执行通过 `executeTool` 注入，Phase 2 使用 mock 实现。
 *
 * 设计：纯函数 `runTurn()`，不持有状态，所有状态通过参数传入。
 * 这样 Session 类只做状态管理，循环逻辑可独立测试。
 */

import type {
    CallLLM,
    ChatMessage,
    LLMResponse,
    ContentBlock,
    ParsedAssistant,
    AgentStepTrace,
    TurnResult,
    TurnStatus,
    ExecuteTool,
    TokenUsage,
} from '../types.js'

/** 单轮对话的最大步骤数，防止无限循环。 */
const MAX_STEPS = 25

// ─── 响应解析 ─────────────────────────────────────────────────────────────────

/**
 * 从 LLM 响应中提取文本内容和工具调用块。
 *
 * 将 ContentBlock[] 分拆为两个维度：
 *   - textContent：所有 TextBlock 拼接的纯文本
 *   - toolUseBlocks：所有 ToolUseBlock 的结构化数据
 */
function normalizeLLMResponse(response: LLMResponse): {
    textContent: string
    toolUseBlocks: Array<{ id: string; name: string; input: unknown }>
    stopReason: string
    usage: Partial<TokenUsage> | undefined
    reasoningContent: string | undefined
} {
    let textContent = ''
    const toolUseBlocks: Array<{ id: string; name: string; input: unknown }> =
        []

    for (const block of response.content) {
        if (block.type === 'text') {
            textContent += block.text
        } else if (block.type === 'tool_use') {
            toolUseBlocks.push({
                id: block.id,
                name: block.name,
                input: block.input,
            })
        }
    }

    return {
        textContent,
        toolUseBlocks,
        stopReason: response.stop_reason,
        usage: response.usage,
        reasoningContent: response.reasoning_content,
    }
}

/**
 * 将 normalized 响应转为 ParsedAssistant 结构。
 *
 * 判定逻辑：
 *   1. 有工具调用 → action（取第一个工具），文本部分作为 thinking
 *   2. 无工具调用但有文本 → final
 *   3. 两者皆无 → 空对象
 */
function parseLLMResponse(
    textContent: string,
    toolUseBlocks: Array<{ id: string; name: string; input: unknown }>,
): ParsedAssistant {
    if (toolUseBlocks.length > 0) {
        const firstTool = toolUseBlocks[0]!
        return {
            action: {
                tool: firstTool.name,
                input: firstTool.input,
            },
            actions: toolUseBlocks.map((b) => ({
                tool: b.name,
                input: b.input,
            })),
            thinking: textContent.trim() || undefined,
        }
    }

    if (textContent.trim()) {
        return { final: textContent }
    }

    return {}
}

/**
 * 构建 assistant 消息的 tool_calls 字段。
 *
 * 将内部 toolUseBlock 格式转为 OpenAI tool_calls 格式，
 * 以便正确追加到对话历史中。
 */
function buildAssistantToolCalls(
    blocks: Array<{ id: string; name: string; input: unknown }>,
) {
    return blocks.map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: {
            name: b.name,
            arguments: JSON.stringify(b.input),
        },
    }))
}

// ─── ReAct 循环 ──────────────────────────────────────────────────────────────

/** runTurn 的依赖注入参数。 */
export type RunTurnDeps = {
    /** 对话历史（会被就地修改）。 */
    history: ChatMessage[]
    /** LLM 调用函数。 */
    callLLM: CallLLM
    /** 工具执行函数（Phase 2 默认 mock）。 */
    executeTool?: ExecuteTool
}

/** 默认的 mock 工具执行函数。 */
const defaultExecuteTool: ExecuteTool = async (
    toolName: string,
    _toolInput: unknown,
) => {
    return `[tool "${toolName}" not implemented yet]`
}

/**
 * 执行一次 Turn 的 ReAct 循环。
 *
 * 流程：
 *   1. 将用户输入追加到 history
 *   2. 循环调用 LLM → 解析响应 → 处理工具/最终回答
 *   3. 返回 TurnResult
 *
 * @param input - 用户输入文本
 * @param deps  - 依赖注入（history, callLLM, executeTool）
 */
export async function runTurn(
    input: string,
    deps: RunTurnDeps,
): Promise<TurnResult> {
    const { history, callLLM } = deps
    const executeTool = deps.executeTool ?? defaultExecuteTool

    // 步骤轨迹记录
    const steps: AgentStepTrace[] = []
    let finalText = ''
    let status: TurnStatus = 'ok'
    let errorMessage: string | undefined
    const turnUsage: Partial<TokenUsage> = {
        prompt: 0,
        completion: 0,
        total: 0,
    }

    // 1. 将用户输入追加到历史
    history.push({ role: 'user', content: input })

    // 2. ReAct 主循环
    for (let step = 0; step < MAX_STEPS; step++) {
        // 调用 LLM
        let normalized: ReturnType<typeof normalizeLLMResponse>
        try {
            const llmResult = await callLLM(history)
            normalized = normalizeLLMResponse(llmResult)
        } catch (err) {
            const msg = `LLM call failed: ${(err as Error).message}`
            history.push({ role: 'assistant', content: msg })
            status = 'error'
            finalText = msg
            errorMessage = msg
            break
        }

        const { textContent, toolUseBlocks, usage, reasoningContent } =
            normalized

        // 累加 token 用量
        if (usage) {
            turnUsage.prompt = (turnUsage.prompt ?? 0) + (usage.prompt ?? 0)
            turnUsage.completion =
                (turnUsage.completion ?? 0) + (usage.completion ?? 0)
            turnUsage.total = (turnUsage.total ?? 0) + (usage.total ?? 0)
        }

        // 解析响应
        const parsed = parseLLMResponse(textContent, toolUseBlocks)

        // 记录步骤
        const stepTrace: AgentStepTrace = {
            index: step,
            assistantText: textContent,
            parsed,
            tokenUsage: usage,
        }
        steps.push(stepTrace)

        // 将 assistant 消息追加到历史
        if (toolUseBlocks.length > 0) {
            // 有工具调用时，需要带上 tool_calls
            history.push({
                role: 'assistant',
                content: textContent,
                reasoning_content: reasoningContent,
                tool_calls: buildAssistantToolCalls(toolUseBlocks),
            })
        } else if (textContent) {
            history.push({
                role: 'assistant',
                content: textContent,
                reasoning_content: reasoningContent,
            })
        }

        // 分支判断
        if (parsed.action) {
            // ── Think → Act → Observe ──
            // 执行所有工具调用（LLM 可能一次返回多个）
            const observations: string[] = []

            for (const block of toolUseBlocks) {
                console.log(`  🔧 [step ${step}] calling tool: ${block.name}`)

                let observation: string
                try {
                    observation = await executeTool(block.name, block.input)
                } catch (err) {
                    observation = `Tool execution error: ${(err as Error).message}`
                }

                observations.push(observation)

                // 每个 tool_call 必须有对应的 tool 消息
                history.push({
                    role: 'tool',
                    content: observation,
                    tool_call_id: block.id,
                    name: block.name,
                })
            }

            // 记录第一个工具的 observation（用于 stepTrace）
            stepTrace.observation = observations.join('\n---\n')
            stepTrace.toolCallCount = toolUseBlocks.length

            // 继续循环（Observe → 下一轮 Think）
            continue
        }

        if (parsed.final) {
            // ── 最终回答 ──
            finalText = parsed.final
            break
        }

        // ── 既无 action 也无 final → 异常退出，防止死循环 ──
        finalText =
            textContent || 'No response from LLM.'
        break
    }

    // 超过最大步骤数保护
    if (!finalText && status === 'ok') {
        status = 'error'
        errorMessage = `Exceeded max steps (${MAX_STEPS}).`
        finalText = 'I reached the maximum number of steps. Please try a simpler request.'
    }

    return {
        finalText,
        steps,
        status,
        errorMessage,
        tokenUsage: turnUsage,
    }
}
