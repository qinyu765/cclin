/**
 * @file MCP 客户端 — 管理 MCP Server 的连接生命周期。
 *
 * Phase 9：通过 @modelcontextprotocol/sdk 与外部 MCP Server 通信。
 *
 * 职责：
 *   1. 建立与 MCP Server 的连接（stdio / HTTP / SSE）
 *   2. 发现 Server 提供的工具列表
 *   3. 代理调用远端工具
 *   4. 管理连接生命周期（连接池 + 清理）
 *
 * 传输方式：
 *   - stdio：本地子进程（command + args）
 *   - StreamableHTTP：推荐的远程 HTTP 协议（优先尝试）
 *   - SSE：旧版远程协议（作为 HTTP 的 fallback）
 *
 * 认证支持：
 *   - Bearer Token（静态 token）
 *   - Client Credentials（OAuth 2.0 客户端凭据流）
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type {
    MCPServerConfig,
    MCPStdioConfig,
    MCPRemoteConfig,
} from '../types.js'

// ─── 连接信息 ──────────────────────────────────────────────────────────────

/** 单个 MCP Server 的连接信息。 */
type McpConnection = {
    /** Server 名称。 */
    name: string
    /** MCP SDK Client 实例。 */
    client: Client
    /** 传输层实例（stdio / HTTP / SSE）。 */
    transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport
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

// ─── 类型守卫 ──────────────────────────────────────────────────────────────

/** 判断是否为 stdio 配置（有 command 字段）。 */
function isStdioConfig(c: MCPServerConfig): c is MCPStdioConfig {
    return 'command' in c
}

/** 判断是否为远程配置（有 url 字段）。 */
function isRemoteConfig(c: MCPServerConfig): c is MCPRemoteConfig {
    return 'url' in c
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

/**
 * Build auth headers from config.
 *
 * Converts auth config to an Authorization header value.
 * Injected via requestInit.headers to avoid OAuthClientProvider complexity.
 */
function buildAuthHeaders(
    auth?: MCPRemoteConfig['auth'],
): Record<string, string> | undefined {
    if (!auth) return undefined

    if (auth.type === 'bearer') {
        return { Authorization: `Bearer ${auth.token}` }
    }

    if (auth.type === 'client_credentials') {
        const encoded = Buffer.from(
            `${auth.clientId}:${auth.clientSecret}`,
        ).toString('base64')
        return { Authorization: `Basic ${encoded}` }
    }

    return undefined
}

/**
 * Transport 工厂：根据配置创建对应的传输层实例。
 *
 * - stdio：直接创建 StdioClientTransport
 * - remote（transport='sse'）：强制使用 SSEClientTransport
 * - remote（transport='http' 或默认）：先尝试 StreamableHTTP，
 *   connect 失败则 fallback 到 SSE
 */
async function createTransportAndConnect(
    config: MCPServerConfig,
): Promise<{
    client: Client
    transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport
}> {
    const client = new Client(
        { name: 'cclin-agent', version: '0.1.0' },
        { capabilities: {} },
    )

    // ── stdio 模式 ──
    if (isStdioConfig(config)) {
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: mergeProcessEnv(config.env),
            stderr: 'ignore',
        })
        await client.connect(transport)
        return { client, transport }
    }

    // ── 远程模式 ──
    const url = new URL(config.url)
    const authHeaders = buildAuthHeaders(config.auth)
    const mergedHeaders = { ...authHeaders, ...config.headers }
    const hasHeaders = Object.keys(mergedHeaders).length > 0
    const transportOpts = hasHeaders
        ? { requestInit: { headers: mergedHeaders } }
        : {}

    // 强制 SSE
    if (config.transport === 'sse') {
        const transport = new SSEClientTransport(url, transportOpts)
        await client.connect(transport)
        return { client, transport }
    }

    // 默认：StreamableHTTP 优先，fallback SSE
    try {
        const transport = new StreamableHTTPClientTransport(url, transportOpts)
        await client.connect(transport)
        return { client, transport }
    } catch {
        // StreamableHTTP 连接失败，fallback 到 SSE
        const fallbackClient = new Client(
            { name: 'cclin-agent', version: '0.1.0' },
            { capabilities: {} },
        )
        const transport = new SSEClientTransport(url, transportOpts)
        await fallbackClient.connect(transport)
        return { client: fallbackClient, transport }
    }
}

// ─── McpClientPool 类 ─────────────────────────────────────────────────────

/**
 * MCP 客户端连接池。
 *
 * 管理多个 MCP Server 的连接（stdio / HTTP / SSE）：
 *   - 懒连接（首次使用时建立）
 *   - 连接复用（同一 Server 不会重复连接）
 *   - 统一清理
 */
export class McpClientPool {
    private connections: Map<string, McpConnection> = new Map()

    /**
     * 连接到指定 MCP Server。
     *
     * 根据配置自动选择 stdio / HTTP / SSE 传输方式。
     * 如果已经连接过，直接返回已有连接。
     */
    async connect(
        name: string,
        config: MCPServerConfig,
    ): Promise<McpConnection> {
        // 连接复用
        const existing = this.connections.get(name)
        if (existing) return existing

        // 通过工厂创建 transport 并连接
        const { client, transport } =
            await createTransportAndConnect(config)

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
