/**
 * @file MCP 工具注册表，将 MCP Server 工具适配为 ToolDefinition。
 */

import type {
    MCPServerConfig,
    McpToolDefinition,
    ToolInputSchema,
} from '../types.js'
import { McpClientPool } from './mcp-client.js'

export class McpToolRegistry {
    private pool = new McpClientPool()
    private tools: Map<string, McpToolDefinition> = new Map()

    private resolveIsMutating(
        config: MCPServerConfig,
        toolName: string,
    ): boolean {
        return config.tools?.[toolName]?.isMutating
            ?? config.defaultMutating
            ?? true
    }

    async loadServers(
        servers: Record<string, MCPServerConfig>,
    ): Promise<number> {
        const entries = Object.entries(servers)
        if (entries.length === 0) return 0

        let loadedTools = 0
        const failures: string[] = []

        for (const [serverName, config] of entries) {
            try {
                const discovered = await this.pool.discoverTools(
                    serverName,
                    config,
                )

                for (const rawTool of discovered) {
                    const qualifiedName =
                        `${serverName}_${rawTool.name}`
                    if (this.tools.has(qualifiedName)) {
                        console.warn(
                            `[MCP] overwriting existing tool "${qualifiedName}" from server "${serverName}"`,
                        )
                    }

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
                        isMutating: this.resolveIsMutating(
                            config,
                            rawTool.name,
                        ),
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

                loadedTools += discovered.length
                console.log(
                    `[MCP] Loaded ${discovered.length} tools from "${serverName}"`,
                )
            } catch (err) {
                const message = (err as Error).message
                failures.push(`${serverName}: ${message}`)
                console.error(
                    `[MCP] Failed to connect to "${serverName}":`,
                    message,
                )
            }
        }

        console.log(
            `[MCP] Summary: ${entries.length - failures.length}/${entries.length} servers connected, ${loadedTools} tools loaded.`,
        )
        if (failures.length > 0) {
            console.warn(`[MCP] Failed servers: ${failures.join('; ')}`)
        }

        return this.tools.size
    }

    get(name: string): McpToolDefinition | undefined {
        return this.tools.get(name)
    }

    getAll(): McpToolDefinition[] {
        return Array.from(this.tools.values())
    }

    has(name: string): boolean {
        return this.tools.has(name)
    }

    get size(): number {
        return this.tools.size
    }

    async dispose(): Promise<void> {
        await this.pool.closeAll()
        this.tools.clear()
    }
}
