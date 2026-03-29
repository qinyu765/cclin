/**
 * @file Unit tests for ToolRouter (Phase 9).
 *
 * Tests: Native priority, get, has, toOpenAITools, toMarkdown
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolRouter } from './router.js'
import { ToolRegistry } from './registry.js'
import type { ToolDefinition } from '../types.js'

// Simple mock for McpToolRegistry to avoid full MCP client dependency
class MockMcpRegistry {
    tools: Map<string, ToolDefinition> = new Map()

    async getTools() {
        return Array.from(this.tools.values())
    }

    get(name: string) {
        return this.tools.get(name)
    }

    has(name: string) {
        return this.tools.has(name)
    }

    getAll() {
        return Array.from(this.tools.values())
    }
}

describe('ToolRouter', () => {
    let nativeReg: ToolRegistry
    let mcpReg: MockMcpRegistry
    let router: ToolRouter

    beforeEach(() => {
        nativeReg = new ToolRegistry()
        mcpReg = new MockMcpRegistry()
        router = new ToolRouter()
        // Inject nativeRegistry and mcpRegistry manually for tests
        // since they are internal and not passed via constructor
        Object.assign(router, { nativeRegistry: nativeReg, mcpRegistry: mcpReg as any })
    })

    function makeTool(name: string): ToolDefinition {
        return {
            name,
            description: `${name} desc`,
            inputSchema: { type: 'object', properties: {} },
            isMutating: false,
            execute: vi.fn(),
        }
    }

    it('should query both registries for has()', async () => {
        nativeReg.register(makeTool('native_tool'))
        mcpReg.tools.set('mcp_tool', makeTool('mcp_tool'))

        expect(router.has('native_tool')).toBe(true)
        expect(router.has('mcp_tool')).toBe(true)
        expect(router.has('unknown')).toBe(false)
    })

    it('should return undefined from get() if not found', async () => {
        expect(router.get('unknown')).toBeUndefined()
    })

    it('should get from native registry', async () => {
        nativeReg.register(makeTool('native_tool'))
        const tool = router.get('native_tool')
        expect(tool).toBeDefined()
        expect(tool?.name).toBe('native_tool')
    })

    it('should get from mcp registry', async () => {
        mcpReg.tools.set('mcp_tool', makeTool('mcp_tool'))
        const tool = router.get('mcp_tool')
        expect(tool).toBeDefined()
        expect(tool?.name).toBe('mcp_tool')
    })

    it('should prioritize native tools over mcp tools on exact name match', async () => {
        const nativeOne = makeTool('conflict_tool')
        nativeOne.description = 'NATIVE'
        
        const mcpOne = makeTool('conflict_tool')
        mcpOne.description = 'MCP'

        nativeReg.register(nativeOne)
        mcpReg.tools.set('conflict_tool', mcpOne)

        // `get` should return the native one
        const tool = router.get('conflict_tool')
        expect(tool?.description).toBe('NATIVE')
    })

    it('should combine tools from both in getAllTools()', async () => {
        nativeReg.register(makeTool('n1'))
        mcpReg.tools.set('m1', makeTool('m1'))

        const all = router.getAllTools()
        expect(all).toHaveLength(2)
        expect(all.map(t => t.name).sort()).toEqual(['m1', 'n1'])
    })

    it('should correctly build markdown docs', async () => {
        nativeReg.register(makeTool('sys_info'))
        mcpReg.tools.set('web_search', makeTool('web_search'))

        const md = router.toMarkdown()
        expect(md).toContain('### sys_info')
        expect(md).toContain('### web_search')
    })

    it('should correctly format combined list as OpenAI tools', async () => {
        nativeReg.register(makeTool('sys_info'))
        mcpReg.tools.set('web_search', makeTool('web_search'))

        const schemas = router.toOpenAITools()
        expect(schemas).toHaveLength(2)
        
        const names = schemas.map(s => s.function.name).sort()
        expect(names).toEqual(['sys_info', 'web_search'])
    })
})
