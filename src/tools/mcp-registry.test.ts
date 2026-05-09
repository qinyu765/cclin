import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { McpToolRegistry } from './mcp-registry.js'
import type { MCPServerConfig } from '../types.js'

function makeRegistry(pool: {
    discoverTools: ReturnType<typeof vi.fn>
    callTool: ReturnType<typeof vi.fn>
    closeAll?: ReturnType<typeof vi.fn>
}) {
    const registry = new McpToolRegistry()
    Object.assign(registry, {
        pool: {
            closeAll: vi.fn(),
            ...pool,
        },
    })
    return registry
}

describe('McpToolRegistry', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>
    let errorSpy: ReturnType<typeof vi.spyOn>
    let logSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
        warnSpy.mockRestore()
        errorSpy.mockRestore()
        logSpy.mockRestore()
    })

    it('使用 serverName_toolName 注册 MCP 工具', async () => {
        const registry = makeRegistry({
            discoverTools: vi.fn().mockResolvedValue([{
                name: 'search',
                description: 'Search',
                inputSchema: { type: 'object' },
            }]),
            callTool: vi.fn().mockResolvedValue('done'),
        })

        await registry.loadServers({
            github: { command: 'node' },
        })

        expect(registry.has('github_search')).toBe(true)
        expect(registry.get('github_search')?.originalName).toBe('search')
    })

    it('支持 defaultMutating 和工具级 isMutating 覆盖', async () => {
        const registry = makeRegistry({
            discoverTools: vi.fn().mockResolvedValue([
                { name: 'read', description: 'Read', inputSchema: {} },
                { name: 'write', description: 'Write', inputSchema: {} },
            ]),
            callTool: vi.fn().mockResolvedValue('done'),
        })

        await registry.loadServers({
            svc: {
                command: 'node',
                defaultMutating: false,
                tools: {
                    write: { isMutating: true },
                },
            },
        })

        expect(registry.get('svc_read')?.isMutating).toBe(false)
        expect(registry.get('svc_write')?.isMutating).toBe(true)
    })

    it('单个 server 加载失败不影响其他 server', async () => {
        const discoverTools = vi.fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce([{
                name: 'ok',
                description: 'OK',
                inputSchema: {},
            }])
        const registry = makeRegistry({
            discoverTools,
            callTool: vi.fn().mockResolvedValue('done'),
        })

        const total = await registry.loadServers({
            bad: { command: 'node' },
            good: { command: 'node' },
        })

        expect(total).toBe(1)
        expect(registry.has('good_ok')).toBe(true)
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to connect to "bad"'),
            'boom',
        )
    })

    it('重复工具名会记录覆盖诊断', async () => {
        const registry = makeRegistry({
            discoverTools: vi.fn()
                .mockResolvedValueOnce([{
                    name: 'same',
                    description: 'First',
                    inputSchema: {},
                }])
                .mockResolvedValueOnce([{
                    name: 'same',
                    description: 'Second',
                    inputSchema: {},
                }]),
            callTool: vi.fn().mockResolvedValue('done'),
        })

        const servers: Record<string, MCPServerConfig> = {
            svc: { command: 'node' },
        }
        await registry.loadServers(servers)
        await registry.loadServers(servers)

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('overwriting existing tool "svc_same"'),
        )
    })
})
