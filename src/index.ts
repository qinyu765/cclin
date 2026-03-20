/**
 * @file Entry point — minimal readline REPL to validate LLM integration.
 *
 * Phase 1 only: single-turn Q&A, no tool execution, no history management.
 * Will be replaced by a proper Session + TUI in later phases.
 */

import * as readline from 'node:readline'
import dotenv from 'dotenv'
import { createCallLLM } from './llm/client.js'
import type { ChatMessage } from './types.js'

// Load .env
dotenv.config()

const apiKey = process.env.OPENAI_API_KEY
const baseURL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
const model = process.env.MODEL_NAME ?? 'gpt-4o-mini'

if (!apiKey) {
    console.error('❌ Missing OPENAI_API_KEY in .env')
    process.exit(1)
}

// Create LLM caller
const callLLM = createCallLLM({ apiKey, baseURL, model })

// Set up readline
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

console.log(`\n🤖 cclin Phase 1 — LLM Integration Test`)
console.log(`   Model: ${model}`)
console.log(`   Base URL: ${baseURL}`)
console.log(`   Type "exit" to quit.\n`)

// Conversation history (multi-turn)
const history: ChatMessage[] = [
    {
        role: 'system',
        content: 'You are a helpful assistant.',
    },
]

function prompt(): void {
    rl.question('You: ', async (input) => {
        const trimmed = input.trim()
        if (!trimmed || trimmed.toLowerCase() === 'exit') {
            console.log('Bye! 👋')
            rl.close()
            return
        }

        // Add user message to history
        history.push({ role: 'user', content: trimmed })

        try {
            const response = await callLLM(history)

            // Extract text from response
            const text = response.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('')

            console.log(`\nAssistant: ${text}`)

            // Show token usage
            if (response.usage) {
                const u = response.usage
                console.log(
                    `  [tokens: prompt=${u.prompt ?? '?'}, completion=${u.completion ?? '?'}, total=${u.total ?? '?'}]`,
                )
            }

            // Show reasoning if present
            if (response.reasoning_content) {
                console.log(`  [thinking: ${response.reasoning_content.slice(0, 100)}...]`)
            }

            console.log()

            // Add assistant response to history
            history.push({ role: 'assistant', content: text })
        } catch (err) {
            console.error(`\n❌ Error: ${(err as Error).message}\n`)
        }

        prompt()
    })
}

prompt()
