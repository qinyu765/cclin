/**
 * @file 入口文件 — readline REPL，通过 Session 驱动 ReAct 循环。
 *
 * Phase 2：通过 Session 管理多轮对话，使用 ReAct 循环处理每轮输入。
 * 后续阶段将替换为正式的 TUI。
 */

import * as readline from 'node:readline'
import dotenv from 'dotenv'
import { createCallLLM } from './llm/client.js'
import { Session } from './runtime/session.js'

// 加载 .env 环境变量
dotenv.config()

const apiKey = process.env.OPENAI_API_KEY
const baseURL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
const model = process.env.MODEL_NAME ?? 'gpt-4o-mini'

if (!apiKey) {
    console.error('❌ Missing OPENAI_API_KEY in .env')
    process.exit(1)
}

// 创建 LLM 调用函数
const callLLM = createCallLLM({ apiKey, baseURL, model })

// 创建 Session（带系统提示词）
const session = new Session({
    callLLM,
    systemPrompt: 'You are a helpful assistant.',
})

// 初始化 readline 交互接口
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

console.log(`\n🤖 cclin Phase 2 — ReAct Loop`)
console.log(`   Model: ${model}`)
console.log(`   Base URL: ${baseURL}`)
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
            const toolSteps = result.steps.filter((s) => s.parsed.action)
            if (stepCount > 1 || toolSteps.length > 0) {
                console.log(
                    `  [steps: ${stepCount}, tool calls: ${toolSteps.length}]`,
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
