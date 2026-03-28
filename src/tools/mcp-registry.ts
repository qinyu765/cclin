/**
 * @file MCP 工具注册表 — 将 MCP Server 的工具适配为 ToolDefinition。
 *
 * Phase 9：连接 MCP Server，发现工具，生成可执行的 ToolDefinition。
 *
 * 职责：
 *   1. 使用 McpClientPool 连接 MCP Server
 *   2. 将发现的工具转换为 cclin 的 ToolDefinition 格式
 *   3. 工具名添加 serverName_ 前缀避免冲突
 *   4. 提供标准查询接口（get/getAll/has/size）
 */

import type {
    MCPServerConfig,
    McpToolDefinition,
    ToolInputSchema,
} from '../types.js'
import { McpClientPool } from './mcp-client.js'

// ─── McpToolRegistry 类 ──────────────────────────────────────────────────

/**
 * MCP 工具注册表。
 *
 * 将 MCP Server 的远端工具适配为本地 ToolDefinition，
 * 使其可以无缝接入 ToolRouter 和 ToolOrchestrator。
 */
export class McpToolRegistry {
    private pool = new McpClientPool()
    private tools: Map<string, McpToolDefinition> = new Map()

    /**
     * 连接并加载所有配置的 MCP Server。
     *
     * @returns 成功加载的工具总数
     */
    async loadServers(
        servers: Record<string, MCPServerConfig>,
    ): Promise<number> {
        const entries = Object.entries(servers)
        if (entries.length === 0) return 0

        for (const [serverName, config] of entries) {
            try {
                const discovered = await this.pool.discoverTools(
                    serverName,
                    config,
                )

                for (const rawTool of discovered) {
                    // 工具名：serverName_originalName
                    const qualifiedName =
                        `${serverName}_${rawTool.name}`

                    const tool: McpToolDefinition = {
                        name: qualifiedName,
                        description:
                            rawTool.description ||
                            `Tool from ${serverName}: ${rawTool.name}`,
                        inputSchema:
                            (rawTool.inputSchema as ToolInputSchema) ?? {
                                type: 'object',
                                properties: {},
                            },
                        isMutating: true, // 保守策略：MCP 工具默认需要审批
                        source: 'mcp',
                        serverName,
                        originalName: rawTool.name,
                        execute: async (input) => {
                            const result =
                                await this.pool.callTool(
                                    serverName,
                                    rawTool.name,
                                    input,
                                )
                            const isError =
                                result.startsWith('Error:')
                            return { output: result, isError }
                        },
                    }

                    this.tools.set(qualifiedName, tool)
                }

                console.log(
                    `[MCP] Loaded ${discovered.length} tools from "${serverName}"`,
                )
            } catch (err) {
                console.error(
                    `[MCP] Failed to connect to "${serverName}":`,
                    (err as Error).message,
                )
            }
        }

        return this.tools.size
    }

    /** 获取指定工具。 */
    get(name: string): McpToolDefinition | undefined {
        return this.tools.get(name)
    }

    /** 获取所有 MCP 工具。 */
    getAll(): McpToolDefinition[] {
        return Array.from(this.tools.values())
    }

    /** 检查工具是否存在。 */
    has(name: string): boolean {
        return this.tools.has(name)
    }

    /** 已注册 MCP 工具数量。 */
    get size(): number {
        return this.tools.size
    }

    /** 清理所有 MCP 连接。 */
    async dispose(): Promise<void> {
        await this.pool.closeAll()
        this.tools.clear()
    }
}
