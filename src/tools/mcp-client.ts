/**
 * @file MCP 客户端，管理 MCP Server 连接、工具发现和工具调用。
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

type McpTransport =
    | StdioClientTransport
    | StreamableHTTPClientTransport
    | SSEClientTransport

export type McpConnection = {
    name: string
    client: Client
    transport: McpTransport
    timeoutMs?: number
}

export type McpDiscoveredTool = {
    name: string
    description: string
    inputSchema: Record<string, unknown>
}

function isStdioConfig(c: MCPServerConfig): c is MCPStdioConfig {
    return 'command' in c
}

function mergeProcessEnv(
    env?: Record<string, string>,
): Record<string, string> | undefined {
    if (!env) return undefined
    const merged: Record<string, string | undefined> = {
        ...process.env,
        ...env,
    }
    const entries = Object.entries(merged).filter(
        (entry): entry is [string, string] =>
            typeof entry[1] === 'string',
    )
    return Object.fromEntries(entries)
}

export function buildMcpAuthHeaders(
    auth?: MCPRemoteConfig['auth'],
): Record<string, string> | undefined {
    if (!auth) return undefined

    if (auth.type === 'bearer') {
        return { Authorization: `Bearer ${auth.token}` }
    }

    if (auth.type === 'basic') {
        const encoded = Buffer.from(
            `${auth.username}:${auth.password}`,
        ).toString('base64')
        return { Authorization: `Basic ${encoded}` }
    }

    if (auth.type === 'client_credentials') {
        console.warn(
            '[MCP] auth.type "client_credentials" is deprecated; use "basic" for Basic Auth.',
        )
        const encoded = Buffer.from(
            `${auth.clientId}:${auth.clientSecret}`,
        ).toString('base64')
        return { Authorization: `Basic ${encoded}` }
    }

    return undefined
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number | undefined,
    label: string,
): Promise<T> {
    if (!timeoutMs) return promise

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`${label} timed out after ${timeoutMs}ms`))
                }, timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function createClient(): Client {
    return new Client(
        { name: 'cclin-agent', version: '0.1.0' },
        { capabilities: {} },
    )
}

function createRemoteTransportOptions(config: MCPRemoteConfig) {
    const authHeaders = buildMcpAuthHeaders(config.auth)
    const mergedHeaders = { ...authHeaders, ...(config.headers ?? {}) }
    return Object.keys(mergedHeaders).length > 0
        ? { requestInit: { headers: mergedHeaders } }
        : {}
}

export async function createMcpTransportAndConnect(
    config: MCPServerConfig,
): Promise<{
    client: Client
    transport: McpTransport
}> {
    const client = createClient()

    if (isStdioConfig(config)) {
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: mergeProcessEnv(config.env),
            stderr: 'ignore',
        })
        await withTimeout(
            client.connect(transport),
            config.timeoutMs,
            'MCP stdio connect',
        )
        return { client, transport }
    }

    const url = new URL(config.url)
    const transportOpts = createRemoteTransportOptions(config)

    if (config.transport === 'sse') {
        const transport = new SSEClientTransport(url, transportOpts)
        await withTimeout(
            client.connect(transport),
            config.timeoutMs,
            'MCP SSE connect',
        )
        return { client, transport }
    }

    try {
        const transport = new StreamableHTTPClientTransport(url, transportOpts)
        await withTimeout(
            client.connect(transport),
            config.timeoutMs,
            'MCP HTTP connect',
        )
        return { client, transport }
    } catch (err) {
        console.warn(
            `[MCP] HTTP connect failed (${(err as Error).message}); falling back to SSE.`,
        )
        const fallbackClient = createClient()
        const transport = new SSEClientTransport(url, transportOpts)
        await withTimeout(
            fallbackClient.connect(transport),
            config.timeoutMs,
            'MCP SSE fallback connect',
        )
        return { client: fallbackClient, transport }
    }
}

type McpContentItem = {
    type?: string
    text?: string
    uri?: string
    mimeType?: string
    [key: string]: unknown
}

function formatMcpContent(content: unknown): string {
    const items = Array.isArray(content) ? content as McpContentItem[] : []
    const parts: string[] = []

    for (const item of items) {
        if (item.type === 'text' && item.text) {
            parts.push(item.text)
            continue
        }
        if (item.type === 'json') {
            const value = item.json ?? item.data ?? item
            parts.push(JSON.stringify(value, null, 2))
            continue
        }
        const type = item.type ?? 'unknown'
        const suffix = item.uri ? ` ${item.uri}` : ''
        parts.push(`[non-text MCP content: ${type}${suffix}]`)
    }

    return parts.join('\n') || '(empty result)'
}

export class McpClientPool {
    private connections: Map<string, McpConnection> = new Map()

    async connect(
        name: string,
        config: MCPServerConfig,
    ): Promise<McpConnection> {
        const existing = this.connections.get(name)
        if (existing) return existing

        const { client, transport } =
            await createMcpTransportAndConnect(config)

        const connection: McpConnection = {
            name,
            client,
            transport,
            timeoutMs: config.timeoutMs,
        }
        this.connections.set(name, connection)
        return connection
    }

    async discoverTools(
        name: string,
        config: MCPServerConfig,
    ): Promise<McpDiscoveredTool[]> {
        const conn = await this.connect(name, config)
        const result = await withTimeout(
            conn.client.listTools(),
            config.timeoutMs,
            `MCP listTools for "${name}"`,
        )

        return (result.tools || []).map((t) => ({
            name: t.name,
            description: t.description || `Tool from ${name}: ${t.name}`,
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
        }))
    }

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

        const result = await withTimeout(
            conn.client.callTool({
                name: toolName,
                arguments: args,
            }),
            conn.timeoutMs,
            `MCP callTool "${serverName}.${toolName}"`,
        )

        const output = formatMcpContent(result.content)
        if (result.isError) {
            return `Error: ${output || 'Unknown MCP tool error'}`
        }
        return output
    }

    async closeAll(): Promise<void> {
        const tasks = Array.from(this.connections.values()).map(
            async (conn) => {
                try {
                    await conn.client.close()
                } catch {
                    // ignore
                }
            },
        )
        await Promise.all(tasks)
        this.connections.clear()
    }

    get size(): number {
        return this.connections.size
    }
}
