/**
 * @file Unit tests for ToolRegistry (Phase 3).
 *
 * Tests: register, get, has, size, getAll, registerMany,
 *        toOpenAITools, toMarkdown
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from './registry.js'
import type { ToolDefinition } from '../types.js'

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function makeTool(name: string, mutating = false): ToolDefinition {
    return {
        name,
        description: `${name} tool description`,
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'file path' },
            },
            required: ['path'],
        },
        isMutating: mutating,
        execute: async () => ({ output: `${name} result` }),
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
    let registry: ToolRegistry

    beforeEach(() => {
        registry = new ToolRegistry()
    })

    it('should start empty', () => {
        expect(registry.size).toBe(0)
        expect(registry.getAll()).toEqual([])
    })

    it('should register and retrieve a tool', () => {
        const tool = makeTool('read_file')
        registry.register(tool)

        expect(registry.size).toBe(1)
        expect(registry.has('read_file')).toBe(true)
        expect(registry.get('read_file')).toBe(tool)
    })

    it('should return undefined for unknown tools', () => {
        expect(registry.get('nonexistent')).toBeUndefined()
        expect(registry.has('nonexistent')).toBe(false)
    })

    it('should register many tools at once', () => {
        const tools = [makeTool('a'), makeTool('b'), makeTool('c')]
        registry.registerMany(tools)

        expect(registry.size).toBe(3)
        expect(registry.has('a')).toBe(true)
        expect(registry.has('b')).toBe(true)
        expect(registry.has('c')).toBe(true)
    })

    it('should overwrite on duplicate name', () => {
        const tool1 = makeTool('read_file')
        const tool2 = makeTool('read_file')
        tool2.description = 'updated description'

        registry.register(tool1)
        registry.register(tool2)

        expect(registry.size).toBe(1)
        expect(registry.get('read_file')?.description).toBe(
            'updated description',
        )
    })

    it('should convert to OpenAI tools format', () => {
        registry.register(makeTool('bash'))
        const openAITools = registry.toOpenAITools()

        expect(openAITools).toHaveLength(1)
        expect(openAITools[0]).toEqual({
            type: 'function',
            function: {
                name: 'bash',
                description: 'bash tool description',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'file path',
                        },
                    },
                    required: ['path'],
                },
            },
        })
    })

    it('should generate markdown text', () => {
        registry.register(makeTool('read_file'))
        const md = registry.toMarkdown()

        expect(md).toContain('### read_file')
        expect(md).toContain('read_file tool description')
        expect(md).toContain('Parameters Schema')
        expect(md).toContain('"type": "object"')
    })

    it('should return all tools in insertion order', () => {
        registry.register(makeTool('a'))
        registry.register(makeTool('b'))
        const all = registry.getAll()

        expect(all.map((t) => t.name)).toEqual(['a', 'b'])
    })
})
