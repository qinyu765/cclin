#!/usr/bin/env node
/**
 * @file 入口文件 — Ink TUI，通过 Session 驱动 ReAct 循环。
 *
 * Phase 8：从 readline REPL 升级为 Ink TUI。
 * 核心改动：用 App 组件的 tuiMiddleware 替代 loggerMiddleware，
 * 审批交互从 rl.question 改为 App 组件的审批 UI。
 */

import React from 'react'
import { render } from 'ink'
import { loadConfig } from './config/index.js'
import { createProvider } from './llm/provider.js'
// Side-effect: registers OpenAI provider
import './llm/client.js'
import { Session } from './runtime/session.js'
import { ApprovalManager } from './tools/approval.js'
import { ToolOrchestrator } from './tools/orchestrator.js'
import { ToolRouter } from './tools/router.js'
import { loadMcpConfig } from './tools/mcp-config.js'
import { loadSystemPrompt } from './runtime/prompt.js'
import { createTokenCounter } from './utils/tokenizer.js'
import { readFileTool } from './tools/read-file.js'
import { writeFileTool } from './tools/write-file.js'
import { editFileTool } from './tools/edit-file.js'
import { bashTool } from './tools/bash.js'
import { listDirectoryTool } from './tools/list-directory.js'
import { updatePlanTool } from './tools/update-plan.js'
import { getMemoryTool } from './tools/get-memory.js'
import { rememberNoteTool } from './tools/remember-note.js'
import { searchHistoryTool } from './tools/search-history.js'
import { createSkillTool } from './tools/create-skill.js'
import { searchFilesTool } from './tools/search-files.js'
import { loadSkills, buildSkillsSection } from './runtime/skills.js'
import { createSpawnAgentTool } from './tools/spawn-agent.js'
import { SubAgentManager } from './tools/subagent-manager.js'
import { createAsyncSubAgentTools } from './tools/subagent-tools.js'
import { App } from './tui/app.js'
import { JsonlHistorySink } from './runtime/history.js'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
    AgentMiddleware,
    ApprovalRequest,
    ApprovalDecision,
    UserContent,
} from './types.js'

// 加载配置 (TOML + env overrides)
const config = await loadConfig()

const apiKey = config.llm.api_key
const baseURL = config.llm.base_url
const model = config.llm.model

if (!apiKey) {
    console.error('❌ Missing API key. Set in ~/.cclin/config.toml or OPENAI_API_KEY env var.')
    process.exit(1)
}

// 使用 async IIFE 包裹启动逻辑
;(async () => {

// 创建工具路由器（统一管理内置 + MCP 工具）
const router = new ToolRouter()
router.registerNativeTools([
    readFileTool,
    writeFileTool,
    editFileTool,
    bashTool,
    listDirectoryTool,
    updatePlanTool,
    getMemoryTool,
    rememberNoteTool,
    searchHistoryTool,
    createSkillTool,
    searchFilesTool,
])

// 加载 MCP 配置并连接 MCP Server
const mcpConfig = await loadMcpConfig()
if (Object.keys(mcpConfig).length > 0) {
    await router.loadMcpServers(mcpConfig)
}

// 创建审批管理器和工具编排器（父 Agent）
const approvalManager = new ApprovalManager({ policy: config.approval.policy })
const orchestrator = new ToolOrchestrator(router, approvalManager)

// 子 Agent 专用工具编排器（审批策略=session 即全部自动批准）
const childApprovalManager = new ApprovalManager({ policy: 'session' })
const childOrchestrator = new ToolOrchestrator(router, childApprovalManager)
const childExecuteTool = childOrchestrator.createExecuteTool()

// 加载 Skills
const skills = await loadSkills({ cwd: process.cwd() })
const skillsText = (await buildSkillsSection(skills)) ?? undefined

// 动态加载系统提示词
const systemPrompt = await loadSystemPrompt({
    cwd: process.cwd(),
    toolsText: router.toMarkdown(),
    skillsText,
})

// 创建 Token 计数器
const tokenCounter = createTokenCounter()

// ── 注册 Subagent 工具（systemPrompt 已就绪）─────────────────────────────────
// 破解"callLLM 需要完整工具列表，subagent 工具需要 callLLM"的循环依赖：
//   使用 lazy 代理——工具闭包持有对 `subagentCallLLM` 变量的引用，
//   工具执行时变量已被赋值，所以不会有问题。
let subagentCallLLM: ReturnType<typeof provider.createCallLLM> | null = null

// 方案一：spawn_agent（同进程阻塞式）
const spawnAgentTool = createSpawnAgentTool({
    get callLLM() {
        if (!subagentCallLLM) throw new Error('callLLM not initialized yet')
        return subagentCallLLM
    },
    executeTool: childExecuteTool,
    systemPrompt,
})
// 方案二：异步 Subagent 套件（spawn → send → wait → close）
const subAgentManager = new SubAgentManager(
    (messages, onChunk) => {
        if (!subagentCallLLM) throw new Error('callLLM not initialized yet')
        return subagentCallLLM(messages, onChunk)
    },
    childExecuteTool,
    systemPrompt,
)
const asyncSubAgentTools = createAsyncSubAgentTools(subAgentManager)
router.registerNativeTools([spawnAgentTool, ...asyncSubAgentTools])

// 创建 LLM 调用函数（此时 router 已含 subagent 工具，工具列表完整）
const provider = createProvider(config.llm.provider)
const callLLM = provider.createCallLLM({
    apiKey,
    baseURL,
    model,
    tools: router.toOpenAITools(),
})
// 填充子 Agent 使用的 callLLM（与父 Agent 共享同一个 LLM 连接）
subagentCallLLM = callLLM

// ─── TUI 桥接 ────────────────────────────────────────────────────────────
// Session 需要 middleware，但 middleware 来自已渲染的 App 组件。
// 解法：先渲染 App → App 回传 middleware → 再创建 Session。
// Session 通过 ref 延迟绑定，onSubmit 闭包引用 ref。

let session: Session | null = null
let requestApprovalFn: ((req: ApprovalRequest) => Promise<ApprovalDecision>) | null = null
let onAssistantChunkFn: ((step: number, chunk: string) => void) | null = null

let lastInput = ''

const handleSubmit = async (content: UserContent) => {
    if (!session) return

    // 斜杠命令只在纯文本模式下处理
    const textInput = typeof content === 'string' ? content : ''

    // /compact 命令
    if (textInput === '/compact') {
        await session.compactHistory('manual')
        return
    }

    // /approve 命令
    if (textInput.startsWith('/approve')) {
        const mode = textInput.split(' ')[1]?.toLowerCase()
        if (['always', 'once', 'session'].includes(mode ?? '')) {
            approvalManager.policy = mode as 'always' | 'once' | 'session'
        }
        return
    }

    // /retry 命令 — 重新发送上一次用户输入
    if (textInput === '/retry') {
        if (!lastInput) return
        await session.runTurn(lastInput)
        return
    }

    // /clear 命令 — 清空当前会话上下文
    if (textInput === '/clear') {
        session.getHistory().length = 0
        return
    }

    // 其他未处理的斜杠命令，不发给 LLM
    if (textInput.startsWith('/')) {
        return
    }

    lastInput = textInput || '[multimodal]'
    await session.runTurn(content)
}

let historySink: JsonlHistorySink | null = null

const handleExit = () => {
    tokenCounter.dispose()
    router.dispose().catch(() => { /* ignore */ })
    historySink?.close().catch(() => { /* ignore */ })
}

const handleMiddlewareReady = (mw: AgentMiddleware) => {
    // 每次启动创建新会话历史文件（按日期归档）
    const cclinHome = process.env.CCLIN_HOME ?? path.join(os.homedir(), '.cclin')
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const historyFile = path.join(cclinHome, 'history', `${today}.jsonl`)
    historySink = new JsonlHistorySink(historyFile)

    // Session 在中间件就绪后创建
    session = new Session({
        callLLM,
        systemPrompt,
        executeTool: orchestrator.createExecuteTool({
            requestApproval: (req) => {
                if (!requestApprovalFn) return Promise.resolve('deny' as const)
                return requestApprovalFn(req)
            },
        }),
        tokenCounter,
        contextWindow: 128_000,
        compactThreshold: 80,
        middlewares: [mw],
        historySink: historySink ?? undefined,
        clearApprovalsFn: () => orchestrator.clearOnceApprovals(),
        onAssistantChunk: (step, chunk) => {
            if (onAssistantChunkFn) onAssistantChunkFn(step, chunk)
        },
    })
}

const handleApprovalReady = (fn: (req: ApprovalRequest) => Promise<ApprovalDecision>) => {
    requestApprovalFn = fn
}

const handleAssistantChunkReady = (fn: (step: number, chunk: string) => void) => {
    onAssistantChunkFn = fn
}

// 渲染 Ink TUI
const app = render(
    React.createElement(App, {
        model,
        baseURL,
        toolCount: router.getToolCount().total,
        approvalPolicy: approvalManager.policy,
        cwd: process.cwd(),
        onSubmit: handleSubmit,
        onExit: handleExit,
        onMiddlewareReady: handleMiddlewareReady,
        onApprovalReady: handleApprovalReady,
        onAssistantChunkReady: handleAssistantChunkReady,
    }),
    { exitOnCtrlC: true },
)

await app.waitUntilExit()

})().catch((err) => {
    console.error(`❌ Startup failed: ${(err as Error).message}`)
    process.exit(1)
})
