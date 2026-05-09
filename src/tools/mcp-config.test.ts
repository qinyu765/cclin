import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'

vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(),
}))

vi.mock('node:os', () => ({
    homedir: () => '/home/tester',
}))

import { readFile } from 'node:fs/promises'
import { loadMcpConfig } from './mcp-config.js'

const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>

function enoent(path: string): NodeJS.ErrnoException {
    const err = new Error(`missing ${path}`) as NodeJS.ErrnoException
    err.code = 'ENOENT'
    return err
}

describe('loadMcpConfig', () => {
    const originalCclinHome = process.env.CCLIN_HOME

    beforeEach(() => {
        vi.clearAllMocks()
        delete process.env.CCLIN_HOME
    })

    afterEach(() => {
        if (originalCclinHome) process.env.CCLIN_HOME = originalCclinHome
        else delete process.env.CCLIN_HOME
    })

    it('优先加载项目级 mcp_config.json', async () => {
        mockReadFile.mockResolvedValueOnce(JSON.stringify({
            mcpServers: {
                local: { command: 'node', args: ['server.js'] },
            },
        }))

        const config = await loadMcpConfig('/repo')

        expect(config.local).toMatchObject({ command: 'node' })
        expect(mockReadFile).toHaveBeenCalledTimes(1)
        expect(mockReadFile).toHaveBeenCalledWith(
            join('/repo', 'mcp_config.json'),
            'utf-8',
        )
    })

    it('项目级缺失时从 CCLIN_HOME 加载用户级配置', async () => {
        process.env.CCLIN_HOME = '/custom/cclin'
        mockReadFile
            .mockRejectedValueOnce(enoent('project'))
            .mockResolvedValueOnce(JSON.stringify({
                mcpServers: {
                    remote: { url: 'https://mcp.example.com/mcp' },
                },
            }))

        const config = await loadMcpConfig('/repo')

        expect(config.remote).toMatchObject({
            url: 'https://mcp.example.com/mcp',
        })
        expect(mockReadFile).toHaveBeenNthCalledWith(
            2,
            join('/custom/cclin', 'mcp_config.json'),
            'utf-8',
        )
    })

    it('所有配置文件都缺失时返回空对象', async () => {
        mockReadFile
            .mockRejectedValueOnce(enoent('project'))
            .mockRejectedValueOnce(enoent('user'))

        await expect(loadMcpConfig('/repo')).resolves.toEqual({})
    })

    it('JSON 解析错误不应被静默吞掉', async () => {
        mockReadFile.mockResolvedValueOnce('{ bad json')

        await expect(loadMcpConfig('/repo')).rejects.toThrow(
            /Invalid MCP config JSON/,
        )
    })

    it('拒绝 command 和 url 同时存在的 server 配置', async () => {
        mockReadFile.mockResolvedValueOnce(JSON.stringify({
            mcpServers: {
                bad: {
                    command: 'node',
                    url: 'https://mcp.example.com/mcp',
                },
            },
        }))

        await expect(loadMcpConfig('/repo')).rejects.toThrow(
            /bad.*exactly one of "command" or "url"/,
        )
    })

    it('拒绝非字符串数组 args', async () => {
        mockReadFile.mockResolvedValueOnce(JSON.stringify({
            mcpServers: {
                bad: { command: 'node', args: ['ok', 1] },
            },
        }))

        await expect(loadMcpConfig('/repo')).rejects.toThrow(
            /bad\.args/,
        )
    })

    it('拒绝非法 transport', async () => {
        mockReadFile.mockResolvedValueOnce(JSON.stringify({
            mcpServers: {
                bad: { url: 'https://mcp.example.com/mcp', transport: 'ws' },
            },
        }))

        await expect(loadMcpConfig('/repo')).rejects.toThrow(
            /bad\.transport/,
        )
    })
})
