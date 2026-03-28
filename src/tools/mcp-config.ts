/**
 * @file MCP 配置加载器 — 读取 mcp_config.json。
 *
 * Phase 9：按优先级搜索 MCP 配置文件。
 *
 * 搜索路径（优先级从高到低）：
 *   1. 项目目录 ./mcp_config.json
 *   2. 用户目录 ~/.cclin/mcp_config.json
 *
 * 配置格式：
 * ```json
 * {
 *   "mcpServers": {
 *     "serverName": {
 *       "command": "node",
 *       "args": ["path/to/server.js"],
 *       "env": { "KEY": "value" }
 *     }
 *   }
 * }
 * ```
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { MCPConfigFile, MCPServerConfig } from '../types.js'

/**
 * 加载 MCP 配置。
 *
 * @param cwd — 项目目录（默认 process.cwd()）
 * @returns MCP Server 配置表（可能为空）
 */
export async function loadMcpConfig(
    cwd = process.cwd(),
): Promise<Record<string, MCPServerConfig>> {
    // 搜索路径优先级
    const candidates = [
        join(cwd, 'mcp_config.json'),
        join(homedir(), '.cclin', 'mcp_config.json'),
    ]

    for (const configPath of candidates) {
        try {
            const raw = await readFile(configPath, 'utf-8')
            const parsed = JSON.parse(raw) as MCPConfigFile

            if (
                parsed.mcpServers &&
                typeof parsed.mcpServers === 'object'
            ) {
                console.log(
                    `[MCP] Config loaded from: ${configPath}`,
                )
                return parsed.mcpServers
            }
        } catch {
            // 文件不存在或解析失败，尝试下一个
        }
    }

    // 未找到配置，返回空对象（不是错误）
    return {}
}
