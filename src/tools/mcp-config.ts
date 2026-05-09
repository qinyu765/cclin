/**
 * @file MCP 配置加载器，读取项目级或用户级 mcp_config.json。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type {
    MCPAuthConfig,
    MCPConfigFile,
    MCPServerConfig,
} from '../types.js'

function getCclinHome(): string {
    return process.env.CCLIN_HOME?.trim() || join(homedir(), '.cclin')
}

export function getMcpConfigPaths(cwd = process.cwd()): string[] {
    return [
        join(cwd, 'mcp_config.json'),
        join(getCclinHome(), 'mcp_config.json'),
    ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertStringDict(
    value: unknown,
    field: string,
): asserts value is Record<string, string> {
    if (!isRecord(value)) {
        throw new Error(`${field} must be an object with string values`)
    }
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') {
            throw new Error(`${field}.${key} must be a string`)
        }
    }
}

function assertStringArray(
    value: unknown,
    field: string,
): asserts value is string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(`${field} must be an array of strings`)
    }
}

function validateAuth(auth: unknown, field: string): asserts auth is MCPAuthConfig {
    if (!isRecord(auth)) {
        throw new Error(`${field} must be an object`)
    }
    if (auth.type === 'bearer') {
        if (typeof auth.token !== 'string') {
            throw new Error(`${field}.token must be a string`)
        }
        return
    }
    if (auth.type === 'basic') {
        if (typeof auth.username !== 'string' || typeof auth.password !== 'string') {
            throw new Error(`${field}.username and ${field}.password must be strings`)
        }
        return
    }
    if (auth.type === 'client_credentials') {
        if (
            typeof auth.clientId !== 'string'
            || typeof auth.clientSecret !== 'string'
        ) {
            throw new Error(`${field}.clientId and ${field}.clientSecret must be strings`)
        }
        return
    }
    throw new Error(`${field}.type must be bearer, basic, or client_credentials`)
}

function validateToolOverrides(value: unknown, field: string): void {
    if (!isRecord(value)) {
        throw new Error(`${field} must be an object`)
    }
    for (const [toolName, toolConfig] of Object.entries(value)) {
        if (!isRecord(toolConfig)) {
            throw new Error(`${field}.${toolName} must be an object`)
        }
        if (
            'isMutating' in toolConfig
            && typeof toolConfig.isMutating !== 'boolean'
        ) {
            throw new Error(`${field}.${toolName}.isMutating must be a boolean`)
        }
    }
}

function validateServerConfig(
    name: string,
    value: unknown,
): asserts value is MCPServerConfig {
    if (!isRecord(value)) {
        throw new Error(`MCP server "${name}" must be an object`)
    }

    const hasCommand = 'command' in value
    const hasUrl = 'url' in value
    if (hasCommand === hasUrl) {
        throw new Error(
            `MCP server "${name}" must define exactly one of "command" or "url"`,
        )
    }

    if (hasCommand && typeof value.command !== 'string') {
        throw new Error(`${name}.command must be a string`)
    }
    if (hasUrl && typeof value.url !== 'string') {
        throw new Error(`${name}.url must be a string`)
    }
    if ('args' in value && value.args !== undefined) {
        assertStringArray(value.args, `${name}.args`)
    }
    if ('env' in value && value.env !== undefined) {
        assertStringDict(value.env, `${name}.env`)
    }
    if ('headers' in value && value.headers !== undefined) {
        assertStringDict(value.headers, `${name}.headers`)
    }
    if (
        'transport' in value
        && value.transport !== undefined
        && value.transport !== 'http'
        && value.transport !== 'sse'
    ) {
        throw new Error(`${name}.transport must be "http" or "sse"`)
    }
    if ('auth' in value && value.auth !== undefined) {
        validateAuth(value.auth, `${name}.auth`)
    }
    if (
        'timeoutMs' in value
        && value.timeoutMs !== undefined
        && (
            typeof value.timeoutMs !== 'number'
            || !Number.isFinite(value.timeoutMs)
            || value.timeoutMs <= 0
        )
    ) {
        throw new Error(`${name}.timeoutMs must be a positive number`)
    }
    if (
        'defaultMutating' in value
        && value.defaultMutating !== undefined
        && typeof value.defaultMutating !== 'boolean'
    ) {
        throw new Error(`${name}.defaultMutating must be a boolean`)
    }
    if ('tools' in value && value.tools !== undefined) {
        validateToolOverrides(value.tools, `${name}.tools`)
    }
}

function validateMcpConfigFile(
    value: unknown,
    configPath: string,
): Record<string, MCPServerConfig> {
    if (!isRecord(value)) {
        throw new Error(`Invalid MCP config at ${configPath}: root must be an object`)
    }
    if (!('mcpServers' in value)) {
        throw new Error(`Invalid MCP config at ${configPath}: missing mcpServers`)
    }
    if (!isRecord(value.mcpServers)) {
        throw new Error(`Invalid MCP config at ${configPath}: mcpServers must be an object`)
    }

    for (const [serverName, serverConfig] of Object.entries(value.mcpServers)) {
        validateServerConfig(serverName, serverConfig)
    }

    return value.mcpServers as Record<string, MCPServerConfig>
}

export async function loadMcpConfig(
    cwd = process.cwd(),
): Promise<Record<string, MCPServerConfig>> {
    const candidates = getMcpConfigPaths(cwd)

    for (const configPath of candidates) {
        let raw: string
        try {
            raw = await readFile(configPath, 'utf-8')
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                continue
            }
            throw err
        }

        let parsed: MCPConfigFile
        try {
            parsed = JSON.parse(raw) as MCPConfigFile
        } catch (err) {
            throw new Error(
                `Invalid MCP config JSON at ${configPath}: ${(err as Error).message}`,
            )
        }

        const servers = validateMcpConfigFile(parsed, configPath)
        console.log(`[MCP] Config loaded from: ${configPath}`)
        return servers
    }

    return {}
}
