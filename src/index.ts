/**
 * @file 入口文件 — readline REPL，通过 Session 驱动 ReAct 循环。
 *
 * Phase 3：集成工具系统，Agent 可以读写文件、执行命令。
 * 后续阶段将替换为正式的 TUI。
 */

import * as readline from 'node:readline'
import dotenv from 'dotenv'
import { createCallLLM } from './llm/client.js'
import { Session } from './runtime/session.js'
import { ToolRegistry } from './tools/registry.js'
import { ApprovalManager } from './tools/approval.js'
import { ToolOrchestrator } from './tools/orchestrator.js'
import { readFileTool } from './tools/read-file.js'
import { writeFileTool } from './tools/write-file.js'
import { editFileTool } from './tools/edit-file.js'
import { bashTool } from './tools/bash.js'
import { listDirectoryTool } from './tools/list-directory.js'
import type { ApprovalRequest, ApprovalDecision } from './types.js'

// 加载 .env 环境变量
dotenv.config()

const apiKey = process.env.OPENAI_API_KEY
const baseURL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
const model = process.env.MODEL_NAME ?? 'gpt-4o-mini'

if (!apiKey) {
    console.error('❌ Missing OPENAI_API_KEY in .env')
    process.exit(1)
}

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

// 创建 Session（传入编排器的工具执行函数）
const session = new Session({
    callLLM,
    systemPrompt: 'You are a helpful coding assistant with access to file and shell tools. Use them to help the user.',
    executeTool: orchestrator.createExecuteTool({
        requestApproval: createReadlineApproval(),
    }),
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

console.log(`\n🤖 cclin Phase 4 — Approval & Orchestration`)
console.log(`   Model: ${model}`)
console.log(`   Base URL: ${baseURL}`)
console.log(`   Tools: ${registry.size} registered`)
console.log(`   Approval: once (同指纹本轮只问一次)`)
console.log(`   Session: ${session.id}`)
console.log(`   Type "exit" to quit.\n`)

function prompt(): void {
    rl.question('You: ', async (input) => {
        const trimmed = input.trim()
        if (!trimmed || trimmed.toLowerCase() === 'exit') {
            console.log('Bye! 👋')
            rl.close()
            return
        }

        try {
            const result = await session.runTurn(trimmed)

            // 显示最终回答
            console.log(`\nAssistant: ${result.finalText}`)

            // 显示步骤摘要
            const stepCount = result.steps.length
            const totalToolCalls = result.steps.reduce(
                (sum, s) => sum + (s.toolCallCount ?? 0), 0,
            )
            if (stepCount > 1 || totalToolCalls > 0) {
                console.log(
                    `  [steps: ${stepCount}, tool calls: ${totalToolCalls}]`,
                )
            }

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
