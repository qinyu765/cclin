/**
 * @file 工具注册表 — 管理所有已注册的工具定义。
 *
 * Phase 3：提供工具注册、查询和格式转换能力。
 *
 * 职责：
 *   1. 存储 ToolDefinition 实例
 *   2. 提供 toOpenAITools() 生成 LLM 所需的 tools 参数
 *   3. （功能已转移）提供 createExecuteTool() 生成符合 ExecuteTool 签名的函数
 */

import type { ToolDefinition } from '../types.js'

// ─── ToolRegistry 类 ─────────────────────────────────────────────────────────

/**
 * 工具注册表。
 *
 * 用法：
 * ```ts
 * const registry = new ToolRegistry()
 * registry.register(readFileTool)
 * registry.register(bashTool)
 *
 * const tools = registry.toOpenAITools()  // 传给 LLM
 * （功能已转移）const executeTool = registry.createExecuteTool()  // 传给 ReAct 循环
 * ```
 */
export class ToolRegistry {
    private tools: Map<string, ToolDefinition> = new Map()

    /** 注册单个工具。 */
    register(tool: ToolDefinition): void {
        this.tools.set(tool.name, tool)
    }

    /** 批量注册工具。 */
    registerMany(tools: ToolDefinition[]): void {
        for (const tool of tools) {
            this.register(tool)
        }
    }

    /** 获取指定工具。 */
    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name)
    }

    /** 获取所有工具。 */
    getAll(): ToolDefinition[] {
        return Array.from(this.tools.values())
    }

    /** 检查工具是否存在。 */
    has(name: string): boolean {
        return this.tools.has(name)
    }

    /** 已注册工具数量。 */
    get size(): number {
        return this.tools.size
    }

    /**
     * 转换为 OpenAI function calling 的 tools 参数格式。
     */
    toOpenAITools(): Array<{
        type: 'function'
        function: {
            name: string
            description: string
            parameters: Record<string, unknown>
        }
    }> {
        return this.getAll().map((tool) => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            },
        }))
    }

    /**
     * 转换为 Markdown 文本格式，供系统提示词注入。
     */
    toMarkdown(): string {
        return this.getAll()
            .map(
                (tool) =>
                    `### ${tool.name}\n${tool.description}\n\n**Parameters Schema**:\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\``,
            )
            .join('\n\n')
    }

    /**
     * （功能已转移）生成符合 ExecuteTool 签名的函数。
     */
    // createExecuteTool(): ExecuteTool {
    //     return async (
    //         toolName: string,
    //         toolInput: unknown,
    //     ): Promise<string> => {
    //         const tool = this.get(toolName)
    //         if (!tool) {
    //             return `Error: tool "${toolName}" not found.`
    //         }

    //         try {
    //             const input = (toolInput ?? {}) as Record<
    //                 string,
    //                 unknown
    //             >
    //             const result = await tool.execute(input)
    //             return result.output
    //         } catch (err) {
    //             const msg = (err as Error).message
    //             return `Tool execution error: ${msg}`
    //         }
    //     }
    // }
}
