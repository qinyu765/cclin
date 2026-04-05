/**
 * @file Unit tests for Skills system (Phase 10).
 *
 * Tests: parseSkillFile, renderSkillsSection
 */

import { describe, it, expect } from 'vitest'
import { parseSkillFile, renderSkillsSection } from './skills.js'
import type { SkillMetadata } from './skills.js'

// ─── parseSkillFile ──────────────────────────────────────────────────────────

describe('parseSkillFile', () => {
    it('should parse valid frontmatter with name and description', () => {
        const content = `---
name: git-push
description: Push all changes to remote repository
---

# Git Push Skill

Instructions here...`

        const result = parseSkillFile(content, '/skills/git-push/SKILL.md')

        expect(result).toEqual({
            name: 'git-push',
            description: 'Push all changes to remote repository',
            path: '/skills/git-push/SKILL.md',
        })
    })

    it('should handle quoted values', () => {
        const content = `---
name: "my skill"
description: 'Does cool things'
---
Body`
        const result = parseSkillFile(content, '/test/SKILL.md')
        expect(result).not.toBeNull()
        expect(result!.name).toBe('my skill')
        expect(result!.description).toBe('Does cool things')
    })

    it('should return null when no frontmatter', () => {
        const content = '# Just a header\nSome content'
        expect(parseSkillFile(content, '/test')).toBeNull()
    })

    it('should return null when missing name', () => {
        const content = `---
description: Only description
---
Body`
        expect(parseSkillFile(content, '/test')).toBeNull()
    })

    it('should return null when missing description', () => {
        const content = `---
name: only-name
---
Body`
        expect(parseSkillFile(content, '/test')).toBeNull()
    })

    it('should return null when frontmatter is not closed', () => {
        const content = `---
name: broken
description: no closing fence
Body here`
        expect(parseSkillFile(content, '/test')).toBeNull()
    })

    it('should normalize whitespace in values', () => {
        const content = `---
name: multi   word   name
description: has   extra    spaces
---
Body`
        const result = parseSkillFile(content, '/test')
        expect(result!.name).toBe('multi word name')
        expect(result!.description).toBe('has extra spaces')
    })
})

// ─── renderSkillsSection ─────────────────────────────────────────────────────

describe('renderSkillsSection', () => {
    it('should return null for empty skills array', () => {
        expect(renderSkillsSection([])).toBeNull()
    })

    it('should render all skills with name and description', () => {
        const skills: SkillMetadata[] = [
            { name: 'git-push', description: 'Push changes', path: '/a' },
            { name: 'blog-writer', description: 'Write blogs', path: '/b' },
        ]

        const result = renderSkillsSection(skills)!

        expect(result).toContain('## Skills')
        expect(result).toContain('**git-push**')
        expect(result).toContain('Push changes')
        expect(result).toContain('**blog-writer**')
        expect(result).toContain('Write blogs')
        expect(result).toContain('### How to use skills')
    })
})
