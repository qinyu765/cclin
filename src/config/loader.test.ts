import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from './types.js'

// Mock fs
vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
}))

import { readFile, writeFile } from 'node:fs/promises'
import { loadConfig, getCclinHome, getConfigPath } from './loader.js'

const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>
const mockWriteFile = writeFile as unknown as ReturnType<typeof vi.fn>

describe('getCclinHome', () => {
    const origEnv = process.env.CCLIN_HOME

    afterEach(() => {
        if (origEnv) process.env.CCLIN_HOME = origEnv
        else delete process.env.CCLIN_HOME
    })

    it('uses CCLIN_HOME env if set', () => {
        process.env.CCLIN_HOME = '/custom/home'
        expect(getCclinHome()).toBe('/custom/home')
    })

    it('falls back to ~/.cclin', () => {
        delete process.env.CCLIN_HOME
        const home = require('node:os').homedir()
        expect(getCclinHome()).toBe(join(home, '.cclin'))
    })
})

describe('loadConfig', () => {
    const savedEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
        // Save and clear relevant env vars
        for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MODEL_NAME']) {
            savedEnv[k] = process.env[k]
            delete process.env[k]
        }
        vi.clearAllMocks()
    })

    afterEach(() => {
        // Restore env
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v !== undefined) process.env[k] = v
            else delete process.env[k]
        }
    })

    it('returns defaults when config file missing', async () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        mockReadFile.mockRejectedValue(err)

        const config = await loadConfig()
        expect(config.llm.provider).toBe('openai')
        expect(config.llm.model).toBe(DEFAULT_CONFIG.llm.model)
        expect(mockWriteFile).toHaveBeenCalled() // template created
    })

    it('parses TOML config file', async () => {
        const toml = `
[llm]
provider = "anthropic"
api_key = "sk-test"
model = "claude-3"

[approval]
policy = "always"
`
        mockReadFile.mockResolvedValue(toml)

        const config = await loadConfig()
        expect(config.llm.provider).toBe('anthropic')
        expect(config.llm.api_key).toBe('sk-test')
        expect(config.llm.model).toBe('claude-3')
        expect(config.approval.policy).toBe('always')
        // Defaults for unspecified sections
        expect(config.context.window).toBe(128_000)
    })

    it('env vars override file config', async () => {
        const toml = `
[llm]
api_key = "file-key"
model = "file-model"
`
        mockReadFile.mockResolvedValue(toml)
        process.env.OPENAI_API_KEY = 'env-key'
        process.env.MODEL_NAME = 'env-model'

        const config = await loadConfig()
        expect(config.llm.api_key).toBe('env-key')
        expect(config.llm.model).toBe('env-model')
    })
})
