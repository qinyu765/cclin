/**
 * @file MCP 客户端 — 管理 MCP Server 的连接生命周期。
 *
 * Phase 9：通过 @modelcontextprotocol/sdk 与外部 MCP Server 通信。
 *
 * 职责：
 *   1. 通过 stdio 传输建立与 MCP Server 的连接
 *   2. 发现 Server 提供的工具列表
 *   3. 代理调用远端工具
 *   4. 管理连接生命周期（连接池 + 清理）
 *
 * 设计简化：
 *   - 仅支持 stdio 传输（最常见场景）
 *   - 不引入 HTTP/OAuth 复杂度
 *   - 连接池避免重复连接
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { MCPServerConfig } from '../types.js'

// ─── 连接信息 ──────────────────────────────────────────────────────────────

/** 单个 MCP Server 的连接信息。 */
type McpConnection = {
    /** Server 名称。 */
    name: string
    /** MCP SDK Client 实例。 */
    client: Client
    /** stdio 传输层实例。 */
    transport: StdioClientTransport
}

/** MCP Server 发现到的原始工具信息。 */
export type McpDiscoveredTool = {
    /** 工具原始名称（Server 端的名称）。 */
    name: string
    /** 工具描述。 */
    description: string
    /** 输入参数 JSON Schema。 */
    inputSchema: Record<string, unknown>
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

/** 合并 process.env 与自定义 env 配置。 */
function mergeProcessEnv(
    env?: Record<string, string>,
): Record<string, string> | undefined {
    if (!env) return undefined
    const merged: Record<string, string | undefined> = {
        ...process.env,
        ...env,
    }
    // 过滤掉 undefined 值
    const entries = Object.entries(merged).filter(
        (entry): entry is [string, string] =>
            typeof entry[1] === 'string',
    )
    return Object.fromEntries(entries)
}

// ─── McpClientPool 类 ─────────────────────────────────────────────────────

/**
 * MCP 客户端连接池。
 *
 * 管理多个 MCP Server 的 stdio 连接：
 *   - 懒连接（首次使用时建立）
 *   - 连接复用（同一 Server 不会重复连接）
 *   - 统一清理
 */
export class McpClientPool {
    private connections: Map<string, McpConnection> = new Map()

    /**
     * 连接到指定 MCP Server。
     *
     * 如果已经连接过，直接返回已有连接。
     */
    async connect(
        name: string,
        config: MCPServerConfig,
    ): Promise<McpConnection> {
        // 连接复用
        const existing = this.connections.get(name)
        if (existing) return existing

        // 创建 MCP Client
        const client = new Client(
            { name: 'cclin-agent', version: '0.1.0' },
            { capabilities: {} },
        )

        // 创建 stdio 传输
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: mergeProcessEnv(config.env),
            stderr: 'ignore',
        })

        // 建立连接
        await client.connect(transport)

        const connection: McpConnection = {
            name,
            client,
            transport,
        }
        this.connections.set(name, connection)
        return connection
    }

    /**
     * 发现指定 Server 提供的工具列表。
     *
     * 通过 MCP 协议的 listTools() 方法获取。
     */
    async discoverTools(
        name: string,
        config: MCPServerConfig,
    ): Promise<McpDiscoveredTool[]> {
        const conn = await this.connect(name, config)
        const result = await conn.client.listTools()

        return (result.tools || []).map((t) => ({
            name: t.name,
            description: t.description || `Tool from ${name}: ${t.name}`,
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
        }))
    }

    /**
     * 通过 MCP 协议调用远端工具。
     *
     * @param serverName — 目标 Server 名称
     * @param toolName — 工具原始名称（Server 端的名称）
     * @param args — 工具参数
     */
    async callTool(
        serverName: string,
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<string> {
        const conn = this.connections.get(serverName)
        if (!conn) {
            throw new Error(
                `MCP server "${serverName}" not connected`,
            )
        }

        const result = await conn.client.callTool({
            name: toolName,
            arguments: args,
        })

        // 提取文本内容
        const texts = (result.content as Array<{ type: string; text?: string }> || [])
            .filter((item) => item.type === 'text' && item.text)
            .map((item) => item.text!)

        if (result.isError) {
            return `Error: ${texts.join('\n') || 'Unknown MCP tool error'}`
        }
        return texts.join('\n') || '(empty result)'
    }

    /** 关闭所有 MCP 连接。 */
    async closeAll(): Promise<void> {
        const tasks = Array.from(this.connections.values()).map(
            async (conn) => {
                try {
                    await conn.client.close()
                } catch {
                    // 忽略关闭错误
                }
            },
        )
        await Promise.all(tasks)
        this.connections.clear()
    }

    /** 获取连接数量。 */
    get size(): number {
        return this.connections.size
    }
}
