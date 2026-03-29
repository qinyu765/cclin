/**
 * @file Unit tests for Prompt management (Phase 5).
 *
 * Tests: renderTemplate
 */

import { describe, it, expect } from 'vitest'
import { renderTemplate } from './prompt.js'

describe('renderTemplate', () => {
    it('should replace variables with values', () => {
        const template = 'Hello, {{NAME}}! Welcome to {{PLACE}}.'
        const vars = { NAME: 'Alice', PLACE: 'Wonderland' }
        const result = renderTemplate(template, vars)
        expect(result).toBe('Hello, Alice! Welcome to Wonderland.')
    })

    it('should handle whitespace in template tags', () => {
        const template = 'Value: {{  KEY  }}'
        const vars = { KEY: '123' }
        const result = renderTemplate(template, vars)
        expect(result).toBe('Value: 123')
    })

    it('should replace undefined variables with empty string', () => {
        const template = 'Hello, {{NAME}}!'
        const vars = {} // NAME is missing
        const result = renderTemplate(template, vars)
        expect(result).toBe('Hello, !')
    })

    it('should leave text unchanged if no tags', () => {
        const template = 'Just normal text without tags.'
        const result = renderTemplate(template, { KEY: 'val' })
        expect(result).toBe('Just normal text without tags.')
    })

    it('should replace multiple occurrences of the same variable', () => {
        const template = '{{A}} plus {{A}} is 2{{A}}'
        const result = renderTemplate(template, { A: '1' })
        expect(result).toBe('1 plus 1 is 21')
    })
})
