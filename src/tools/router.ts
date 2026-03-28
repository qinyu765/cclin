/**
 * @file 工具路由器 — 统一管理内置工具和 MCP 工具。
 *
 * Phase 9：在 ToolRegistry（内置）和 McpToolRegistry（MCP）之上
 * 提供统一的工具查询、执行描述生成接口。
 *
 * 设计思路：
 *   1. ToolRouter 不替代 ToolRegistry/McpToolRegistry，而是组合它们
 *   2. 工具查找优先内置，fallback 到 MCP
 *   3. 实现 ToolQueryable 接口，可直接替换 ToolOrchestrator 的依赖
 *   4. toOpenAITools() / toMarkdown() 合并两组工具的输出
 */

import type { ToolDefinition, MCPServerConfig } from '../types.js'
import { ToolRegistry } from './registry.js'
import { McpToolRegistry } from './mcp-registry.js'

// ─── ToolRouter 类 ────────────────────────────────────────────────────────

/**
 * 统一工具路由器。
 *
 * 用法：
 * ```ts
 * const router = new ToolRouter()
 * router.registerNativeTools([readFileTool, bashTool])
 * await router.loadMcpServers(mcpConfig)
 *
 * const tools = router.toOpenAITools()   // 传给 LLM
 * const tool = router.get('bash')        // 查找工具
 * ```
 */
export class ToolRouter {
    private nativeRegistry = new ToolRegistry()
    private mcpRegistry = new McpToolRegistry()

    // ── 注册方法 ──────────────────────────────────────

    /** 注册单个内置工具。 */
    registerNativeTool(tool: ToolDefinition): void {
        this.nativeRegistry.register(tool)
    }

    /** 批量注册内置工具。 */
    registerNativeTools(tools: ToolDefinition[]): void {
        this.nativeRegistry.registerMany(tools)
    }

    /** 连接并加载所有 MCP Server。 */
    async loadMcpServers(
        servers: Record<string, MCPServerConfig>,
    ): Promise<number> {
        return this.mcpRegistry.loadServers(servers)
    }

    // ── 查询方法 ──────────────────────────────────────

    /** 获取指定工具（优先内置，fallback MCP）。 */
    get(name: string): ToolDefinition | undefined {
        return this.nativeRegistry.get(name)
            ?? this.mcpRegistry.get(name)
    }

    /** 获取所有工具（内置 + MCP）。 */
    getAllTools(): ToolDefinition[] {
        return [
            ...this.nativeRegistry.getAll(),
            ...this.mcpRegistry.getAll(),
        ]
    }

    /** 检查工具是否存在。 */
    has(name: string): boolean {
        return this.nativeRegistry.has(name)
            || this.mcpRegistry.has(name)
    }

    /** 获取工具数量统计。 */
    getToolCount(): {
        native: number
        mcp: number
        total: number
    } {
        const native = this.nativeRegistry.size
        const mcp = this.mcpRegistry.size
        return { native, mcp, total: native + mcp }
    }

    // ── 格式转换 ──────────────────────────────────────

    /** 转换为 OpenAI function calling 的 tools 参数格式。 */
    toOpenAITools(): Array<{
        type: 'function'
        function: {
            name: string
            description: string
            parameters: Record<string, unknown>
        }
    }> {
        return this.getAllTools().map((tool) => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            },
        }))
    }

    /** 转换为 Markdown 文本，供系统提示词注入。 */
    toMarkdown(): string {
        const sections: string[] = []

        const nativeTools = this.nativeRegistry.getAll()
        if (nativeTools.length > 0) {
            sections.push('## Built-in Tools\n')
            for (const tool of nativeTools) {
                sections.push(
                    `### ${tool.name}\n${tool.description}\n\n` +
                    `**Parameters Schema**:\n\`\`\`json\n` +
                    `${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\``,
                )
            }
        }

        const mcpTools = this.mcpRegistry.getAll()
        if (mcpTools.length > 0) {
            sections.push('\n## External MCP Tools\n')
            const grouped = new Map<string, typeof mcpTools>()
            for (const tool of mcpTools) {
                const list = grouped.get(tool.serverName) ?? []
                list.push(tool)
                grouped.set(tool.serverName, list)
            }
            for (const [server, tools] of grouped) {
                sections.push(`**Server: ${server}**\n`)
                for (const tool of tools) {
                    sections.push(
                        `### ${tool.name}\n${tool.description}\n\n` +
                        `**Parameters Schema**:\n\`\`\`json\n` +
                        `${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\``,
                    )
                }
            }
        }

        return sections.join('\n\n')
    }

    // ── 生命周期 ──────────────────────────────────────

    /** 清理所有 MCP 连接。 */
    async dispose(): Promise<void> {
        await this.mcpRegistry.dispose()
    }
}
