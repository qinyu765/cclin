import { describe, it, expect, vi, beforeEach } from 'vitest'

const connectMock = vi.fn()
const closeMock = vi.fn()
const listToolsMock = vi.fn()
const callToolMock = vi.fn()

const stdioCtor = vi.fn()
const httpCtor = vi.fn()
const sseCtor = vi.fn()

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: vi.fn().mockImplementation(function () {
        return {
        connect: connectMock,
        close: closeMock,
        listTools: listToolsMock,
        callTool: callToolMock,
        }
    }),
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: vi.fn().mockImplementation(function (opts) {
        stdioCtor(opts)
        return { kind: 'stdio', opts }
    }),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: vi.fn().mockImplementation(function (url, opts) {
        httpCtor(url, opts)
        return { kind: 'http', url, opts }
    }),
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
    SSEClientTransport: vi.fn().mockImplementation(function (url, opts) {
        sseCtor(url, opts)
        return { kind: 'sse', url, opts }
    }),
}))

import {
    buildMcpAuthHeaders,
    createMcpTransportAndConnect,
    McpClientPool,
} from './mcp-client.js'

describe('MCP client helpers', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        connectMock.mockResolvedValue(undefined)
        listToolsMock.mockResolvedValue({ tools: [] })
        callToolMock.mockResolvedValue({ content: [], isError: false })
    })

    it('为 bearer 认证构建 Authorization header', () => {
        expect(buildMcpAuthHeaders({
            type: 'bearer',
            token: 'sk-test',
        })).toEqual({ Authorization: 'Bearer sk-test' })
    })

    it('为 basic 认证构建 Authorization header', () => {
        const headers = buildMcpAuthHeaders({
            type: 'basic',
            username: 'client',
            password: 'secret',
        })

        expect(headers).toEqual({
            Authorization: 'Basic Y2xpZW50OnNlY3JldA==',
        })
    })

    it('兼容旧 client_credentials 配置但打印弃用警告', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const headers = buildMcpAuthHeaders({
            type: 'client_credentials',
            clientId: 'client',
            clientSecret: 'secret',
        })

        expect(headers).toEqual({
            Authorization: 'Basic Y2xpZW50OnNlY3JldA==',
        })
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('client_credentials'),
        )
        warn.mockRestore()
    })

    it('stdio 配置创建 stdio transport 并传递 timeout', async () => {
        await createMcpTransportAndConnect({
            command: 'node',
            args: ['server.js'],
            timeoutMs: 1234,
        })

        expect(stdioCtor).toHaveBeenCalledWith(expect.objectContaining({
            command: 'node',
            args: ['server.js'],
        }))
        expect(connectMock).toHaveBeenCalledTimes(1)
    })

    it('remote 默认先尝试 HTTP，失败后 fallback 到 SSE 并记录原因', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        connectMock
            .mockRejectedValueOnce(new Error('http failed'))
            .mockResolvedValueOnce(undefined)

        await createMcpTransportAndConnect({
            url: 'https://mcp.example.com/mcp',
        })

        expect(httpCtor).toHaveBeenCalledTimes(1)
        expect(sseCtor).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('falling back to SSE'),
        )
        warn.mockRestore()
    })

    it('远程 headers 合并认证和自定义 headers', async () => {
        await createMcpTransportAndConnect({
            url: 'https://mcp.example.com/mcp',
            headers: { 'X-Custom': 'value' },
            auth: { type: 'bearer', token: 'sk-test' },
        })

        expect(httpCtor).toHaveBeenCalledWith(
            expect.any(URL),
            expect.objectContaining({
                requestInit: {
                    headers: {
                        Authorization: 'Bearer sk-test',
                        'X-Custom': 'value',
                    },
                },
            }),
        )
    })
})

describe('McpClientPool', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        connectMock.mockResolvedValue(undefined)
        listToolsMock.mockResolvedValue({ tools: [] })
        callToolMock.mockResolvedValue({ content: [], isError: false })
    })

    it('发现工具时会连接并调用 listTools', async () => {
        listToolsMock.mockResolvedValueOnce({
            tools: [{
                name: 'search',
                description: 'Search',
                inputSchema: { type: 'object' },
            }],
        })
        const pool = new McpClientPool()

        const tools = await pool.discoverTools('remote', {
            url: 'https://mcp.example.com/mcp',
            timeoutMs: 5000,
        })

        expect(tools).toEqual([{
            name: 'search',
            description: 'Search',
            inputSchema: { type: 'object' },
        }])
    })

    it('MCP 非文本结果不会被折叠为 empty result', async () => {
        const pool = new McpClientPool()
        await pool.connect('remote', { url: 'https://mcp.example.com/mcp' })
        callToolMock.mockResolvedValueOnce({
            isError: false,
            content: [
                { type: 'text', text: 'ok' },
                { type: 'image', mimeType: 'image/png' },
                { type: 'resource', uri: 'file:///tmp/a.txt' },
            ],
        })

        const output = await pool.callTool('remote', 'mixed', {})

        expect(output).toContain('ok')
        expect(output).toContain('[non-text MCP content: image]')
        expect(output).toContain('[non-text MCP content: resource file:///tmp/a.txt]')
    })
})
