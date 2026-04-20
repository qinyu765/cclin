/**
 * @file 方案二异步 Subagent 工具集。
 *
 * 将 SubAgentManager 的四个操作暴露为 LLM 可调用的工具：
 *   - spawn_agent_async: 创建子 Agent，立即返回 agent_id
 *   - send_input:        向子 Agent 发送消息（非阻塞）
 *   - wait_agent:        等待子 Agent 完成当前 Turn，返回结果
 *   - close_agent:       关闭子 Agent，释放资源
 *
 * 与方案一的区别：
 *   spawn_agent（方案一）= 创建 + 执行 + 等待（三步合一，阻塞）
 *   spawn_agent_async（方案二）= 仅创建（立即返回 ID），
 *     执行和等待通过 send_input + wait_agent 分开控制
 */

import type { ToolDefinition, ToolResult } from '../types.js'
import type { SubAgentManager } from './subagent-manager.js'

// ─── 工具工厂 ─────────────────────────────────────────────────────────────────

/**
 * 创建方案二的四件套工具。
 *
 * 用法：
 * ```ts
 * const manager = new SubAgentManager(callLLM, executeTool, systemPrompt)
 * const asyncTools = createAsyncSubAgentTools(manager)
 * router.registerNativeTools(asyncTools)
 * ```
 */
export function createAsyncSubAgentTools(
    manager: SubAgentManager,
): ToolDefinition[] {
    return [
        // ── 1. spawn_agent_async ─────────────────────────────────────────────
        {
            name: 'spawn_agent_async',
            description: [
                'Create a new sub-agent and return its ID immediately (non-blocking).',
                'The sub-agent starts in idle state. Use send_input to give it a task.',
                'Use this when you want to run multiple sub-agents in parallel,',
                'or when you need to interact with the sub-agent across multiple turns.',
                '',
                'Returns: agent_id (string) — use this in send_input / wait_agent / close_agent.',
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    system_prompt: {
                        type: 'string',
                        description: 'Optional custom system prompt for the sub-agent.',
                    },
                },
                required: [],
            },
            isMutating: false,

            async execute(input): Promise<ToolResult> {
                const systemPrompt = input['system_prompt'] as string | undefined
                const agentId = manager.spawn({ systemPrompt })
                return {
                    output: [
                        `Sub-agent created successfully.`,
                        `agent_id: ${agentId}`,
                        `Status: idle — use send_input to give it a task.`,
                    ].join('\n'),
                }
            },
        },

        // ── 2. send_input ────────────────────────────────────────────────────
        {
            name: 'send_input',
            description: [
                'Send a message to a sub-agent to start or continue its task.',
                'This is NON-BLOCKING: the sub-agent begins executing but this tool returns immediately.',
                'After calling send_input, you MUST call wait_agent to get the result.',
                '',
                'Parameters:',
                '  agent_id: The ID returned by spawn_agent_async.',
                '  message:  The task or follow-up message for the sub-agent.',
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    agent_id: {
                        type: 'string',
                        description: 'The sub-agent ID from spawn_agent_async.',
                    },
                    message: {
                        type: 'string',
                        description: 'Message to send to the sub-agent.',
                    },
                },
                required: ['agent_id', 'message'],
            },
            isMutating: false,

            async execute(input): Promise<ToolResult> {
                const agentId = input['agent_id'] as string | undefined
                const message = input['message'] as string | undefined

                if (!agentId?.trim()) {
                    return { output: 'Error: agent_id is required.', isError: true }
                }
                if (!message?.trim()) {
                    return { output: 'Error: message is required.', isError: true }
                }

                try {
                    manager.sendInput(agentId, message)
                    return {
                        output: [
                            `Message sent to sub-agent [${agentId.slice(0, 8)}].`,
                            `Status: running — call wait_agent to get the result.`,
                        ].join('\n'),
                    }
                } catch (err) {
                    return {
                        output: `Error: ${(err as Error).message}`,
                        isError: true,
                    }
                }
            },
        },

        // ── 3. wait_agent ────────────────────────────────────────────────────
        {
            name: 'wait_agent',
            description: [
                'Wait for a sub-agent to complete its current task and return the result.',
                'This BLOCKS until the sub-agent finishes.',
                '',
                'Call this after send_input to retrieve the result.',
                'Parameters:',
                '  agent_id: The sub-agent ID to wait for.',
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    agent_id: {
                        type: 'string',
                        description: 'The sub-agent ID to wait for.',
                    },
                },
                required: ['agent_id'],
            },
            isMutating: false,

            async execute(input): Promise<ToolResult> {
                const agentId = input['agent_id'] as string | undefined

                if (!agentId?.trim()) {
                    return { output: 'Error: agent_id is required.', isError: true }
                }

                try {
                    const result = await manager.wait(agentId)
                    return {
                        output: [
                            `[Sub-agent ${agentId.slice(0, 8)}] completed.`,
                            '',
                            result,
                        ].join('\n'),
                    }
                } catch (err) {
                    return {
                        output: `Error: ${(err as Error).message}`,
                        isError: true,
                    }
                }
            },
        },

        // ── 4. close_agent ───────────────────────────────────────────────────
        {
            name: 'close_agent',
            description: [
                'Close a sub-agent and release its resources.',
                'After closing, the agent_id is no longer valid.',
                '',
                'Always close sub-agents when done to prevent resource leaks.',
                'Parameters:',
                '  agent_id: The sub-agent ID to close.',
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    agent_id: {
                        type: 'string',
                        description: 'The sub-agent ID to close.',
                    },
                },
                required: ['agent_id'],
            },
            isMutating: false,

            async execute(input): Promise<ToolResult> {
                const agentId = input['agent_id'] as string | undefined

                if (!agentId?.trim()) {
                    return { output: 'Error: agent_id is required.', isError: true }
                }

                try {
                    manager.close(agentId)
                    return {
                        output: `Sub-agent [${agentId.slice(0, 8)}] closed successfully.`,
                    }
                } catch (err) {
                    return {
                        output: `Error: ${(err as Error).message}`,
                        isError: true,
                    }
                }
            },
        },
    ]
}
