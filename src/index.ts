/**
 * @file 入口文件 — readline REPL，通过 Session 驱动 ReAct 循环。
 *
 * Phase 5：集成 Prompt 管理，系统提示词从模板动态组装。
 * 后续阶段将替换为正式的 TUI。
 */

import * as readline from 'node:readline'
import dotenv from 'dotenv'
import { createCallLLM } from './llm/client.js'
import { Session } from './runtime/session.js'
import { ToolRegistry } from './tools/registry.js'
import { ApprovalManager } from './tools/approval.js'
import { ToolOrchestrator } from './tools/orchestrator.js'
import { loadSystemPrompt } from './runtime/prompt.js'
import { createTokenCounter } from './utils/tokenizer.js'
import { readFileTool } from './tools/read-file.js'
import { writeFileTool } from './tools/write-file.js'
import { editFileTool } from './tools/edit-file.js'
import { bashTool } from './tools/bash.js'
import { listDirectoryTool } from './tools/list-directory.js'
import type { ApprovalRequest, ApprovalDecision, AgentMiddleware } from './types.js'

// 加载 .env 环境变量
dotenv.config()

const apiKey = process.env.OPENAI_API_KEY
const baseURL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
const model = process.env.MODEL_NAME ?? 'gpt-4o-mini'

if (!apiKey) {
    console.error('❌ Missing OPENAI_API_KEY in .env')
    process.exit(1)
}

// 使用 async IIFE 包裹启动逻辑（因为 loadSystemPrompt 是异步的）
;(async () => {

// 创建工具注册表
const registry = new ToolRegistry()
registry.registerMany([
    readFileTool,
    writeFileTool,
    editFileTool,
    bashTool,
    listDirectoryTool,
])

// 创建 LLM 调用函数（传入工具定义）
const callLLM = createCallLLM({
    apiKey,
    baseURL,
    model,
    tools: registry.toOpenAITools(),
})

// 创建审批管理器和工具编排器
const approvalManager = new ApprovalManager({ policy: 'once' })
const orchestrator = new ToolOrchestrator(registry, approvalManager)

// Phase 5：动态加载系统提示词
const systemPrompt = await loadSystemPrompt({ cwd: process.cwd() })

// Phase 6：创建 Token 计数器
const tokenCounter = createTokenCounter()

// Phase 7：创建日志中间件（替代之前硬编码的 console.log）
const loggerMiddleware: AgentMiddleware = {
    name: 'logger',
    onTurnStart: ({ turn, input }) => {
        console.log(`\n── Turn ${turn} ──`)
        console.log(`  💬 Input: ${input.slice(0, 80)}${input.length > 80 ? '...' : ''}`)
    },
    onAction: ({ step, action }) => {
        console.log(`  🔧 [step ${step}] calling tool: ${action.tool}`)
    },
    onObservation: ({ tool, observation }) => {
        const preview = observation.slice(0, 120).replace(/\n/g, ' ')
        console.log(`  📎 [${tool}] ${preview}${observation.length > 120 ? '...' : ''}`)
    },
    onContextUsage: ({ promptTokens, contextWindow, usagePercent, thresholdTokens }) => {
        if (promptTokens >= thresholdTokens) {
            console.log(`  ⚠️ Context: ${promptTokens}/${contextWindow} tokens (${usagePercent}%) — exceeds threshold`)
        }
    },
    onContextCompacted: ({ status, beforeTokens, afterTokens, reductionPercent }) => {
        if (status === 'success') {
            console.log(`  📦 Compacted: ${beforeTokens} → ${afterTokens} tokens (-${reductionPercent}%)`)
        }
    },
}

// 创建 Session（传入编排器的工具执行函数 + Token 计数器 + 中间件）
const session = new Session({
    callLLM,
    systemPrompt,
    executeTool: orchestrator.createExecuteTool({
        requestApproval: createReadlineApproval(),
    }),
    tokenCounter,
    contextWindow: 128_000,
    compactThreshold: 80,
    middlewares: [loggerMiddleware],
})

// 初始化 readline 交互接口
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

/**
 * 创建基于 readline 的审批回调。
 *
 * 当 mutating 工具被调用时，向用户展示确认提示。
 */
function createReadlineApproval() {
    return (request: ApprovalRequest): Promise<ApprovalDecision> => {
        return new Promise((resolve) => {
            console.log(`\n  🔐 审批请求: ${request.toolName}`)
            console.log(`     ${request.reason}`)
            rl.question('     允许执行? (y/n): ', (answer) => {
                const approved = answer.trim().toLowerCase()
                resolve(
                    approved === 'y' || approved === 'yes'
                        ? 'approve'
                        : 'deny',
                )
            })
        })
    }
}

console.log(`\n🤖 cclin Phase 7 — Hook / Middleware System`)
console.log(`   Model: ${model}`)
console.log(`   Base URL: ${baseURL}`)
console.log(`   Tools: ${registry.size} registered`)
console.log(`   Approval: once (同指纹本轮只问一次)`)
console.log(`   Context: 128k window, 80% threshold`)
console.log(`   Middlewares: ${1} registered (logger)`)
console.log(`   Session: ${session.id}`)
console.log(`   Type "exit" to quit, "/compact" to compress context.\n`)

function prompt(): void {
    rl.question('You: ', async (input) => {
        const trimmed = input.trim()
        if (!trimmed || trimmed.toLowerCase() === 'exit') {
            console.log('Bye! 👋')
            tokenCounter.dispose()
            rl.close()
            return
        }

        // Phase 6：/compact 命令
        if (trimmed === '/compact') {
            console.log('\n📦 正在压缩上下文...')
            const result = await session.compactHistory('manual')
            if (result.status === 'success') {
                console.log(`   ✅ 压缩成功: ${result.beforeTokens} → ${result.afterTokens} tokens (减少 ${result.reductionPercent}%)`)
            } else if (result.status === 'skipped') {
                console.log(`   ⚠️ 跳过压缩: ${result.errorMessage ?? '无可压缩内容'}`)
            } else {
                console.log(`   ❌ 压缩失败: ${result.errorMessage}`)
            }
            console.log()
            prompt()
            return
        }

        try {
            const result = await session.runTurn(trimmed)

            // 显示最终回答
            console.log(`\nAssistant: ${result.finalText}`)

            // 显示 token 用量
            if (result.tokenUsage) {
                const u = result.tokenUsage
                console.log(
                    `  [tokens: prompt=${u.prompt ?? '?'}, completion=${u.completion ?? '?'}, total=${u.total ?? '?'}]`,
                )
            }

            // 如果出错，显示错误信息
            if (result.status !== 'ok' && result.errorMessage) {
                console.log(`  ⚠️ Status: ${result.status}`)
            }

            console.log()
        } catch (err) {
            console.error(`\n❌ Error: ${(err as Error).message}\n`)
        }

        prompt()
    })
}

prompt()

})().catch((err) => {
    console.error(`❌ Startup failed: ${(err as Error).message}`)
    process.exit(1)
})
