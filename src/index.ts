/**
 * @file 入口文件 — Ink TUI，通过 Session 驱动 ReAct 循环。
 *
 * Phase 8：从 readline REPL 升级为 Ink TUI。
 * 核心改动：用 App 组件的 tuiMiddleware 替代 loggerMiddleware，
 * 审批交互从 rl.question 改为 App 组件的审批 UI。
 */

import React from 'react'
import { render } from 'ink'
import dotenv from 'dotenv'
import { createCallLLM } from './llm/client.js'
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
import { App } from './tui/app.js'
import type {
    AgentMiddleware,
    ApprovalRequest,
    ApprovalDecision,
} from './types.js'

// 加载 .env 环境变量
dotenv.config()

const apiKey = process.env.OPENAI_API_KEY
const baseURL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
const model = process.env.MODEL_NAME ?? 'gpt-4o-mini'

if (!apiKey) {
    console.error('❌ Missing OPENAI_API_KEY in .env')
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
])

// 加载 MCP 配置并连接 MCP Server
const mcpConfig = await loadMcpConfig()
if (Object.keys(mcpConfig).length > 0) {
    await router.loadMcpServers(mcpConfig)
}

// 创建 LLM 调用函数
const callLLM = createCallLLM({
    apiKey,
    baseURL,
    model,
    tools: router.toOpenAITools(),
})

// 创建审批管理器和工具编排器
const approvalManager = new ApprovalManager({ policy: 'once' })
const orchestrator = new ToolOrchestrator(router, approvalManager)

// 动态加载系统提示词
const systemPrompt = await loadSystemPrompt({
    cwd: process.cwd(),
    toolsText: router.toMarkdown(),
})

// 创建 Token 计数器
const tokenCounter = createTokenCounter()

// ─── TUI 桥接 ────────────────────────────────────────────────────────────
// Session 需要 middleware，但 middleware 来自已渲染的 App 组件。
// 解法：先渲染 App → App 回传 middleware → 再创建 Session。
// Session 通过 ref 延迟绑定，onSubmit 闭包引用 ref。

let session: Session | null = null
let requestApprovalFn: ((req: ApprovalRequest) => Promise<ApprovalDecision>) | null = null

const handleSubmit = async (input: string) => {
    if (!session) return

    // /compact 命令
    if (input === '/compact') {
        await session.compactHistory('manual')
        return
    }

    // /approve 命令
    if (input.startsWith('/approve')) {
        const mode = input.split(' ')[1]?.toLowerCase()
        if (['always', 'once', 'session'].includes(mode ?? '')) {
            approvalManager.policy = mode as 'always' | 'once' | 'session'
        }
        return
    }

    await session.runTurn(input)
}

const handleExit = () => {
    tokenCounter.dispose()
    router.dispose().catch(() => { /* ignore */ })
}

const handleMiddlewareReady = (mw: AgentMiddleware) => {
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
        clearApprovalsFn: () => orchestrator.clearOnceApprovals(),
    })
}

const handleApprovalReady = (fn: (req: ApprovalRequest) => Promise<ApprovalDecision>) => {
    requestApprovalFn = fn
}

// 渲染 Ink TUI
const app = render(
    React.createElement(App, {
        model,
        baseURL,
        toolCount: router.getToolCount().total,
        approvalPolicy: approvalManager.policy,
        onSubmit: handleSubmit,
        onExit: handleExit,
        onMiddlewareReady: handleMiddlewareReady,
        onApprovalReady: handleApprovalReady,
    }),
    { exitOnCtrlC: true },
)

await app.waitUntilExit()

})().catch((err) => {
    console.error(`❌ Startup failed: ${(err as Error).message}`)
    process.exit(1)
})
