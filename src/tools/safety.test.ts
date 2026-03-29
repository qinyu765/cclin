/**
 * @file Unit tests for safety module (Phase 3).
 *
 * Tests: validatePath, classifyCommand, isSensitiveFile
 */

import { describe, it, expect } from 'vitest'
import { validatePath, classifyCommand, isSensitiveFile } from './safety.js'

// ─── validatePath ─────────────────────────────────────────────────────────────

describe('validatePath', () => {
    it('should accept a normal relative path', () => {
        const result = validatePath('src/index.ts')
        expect(result).toEqual({ ok: true })
    })

    it('should accept an absolute path without traversal', () => {
        const result = validatePath('/home/user/project/file.ts')
        expect(result).toEqual({ ok: true })
    })

    it('should reject path traversal with ..', () => {
        const result = validatePath('../../../etc/passwd')
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.error).toContain('Path traversal')
        }
    })

    it('should reject hidden traversal like foo/../../bar', () => {
        const result = validatePath('foo/../../bar')
        expect(result.ok).toBe(false)
    })

    it('should reject access to sensitive files', () => {
        const result = validatePath('.env')
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.error).toContain('sensitive')
        }
    })

    it('should reject access to SSH keys', () => {
        const result = validatePath('id_rsa')
        expect(result.ok).toBe(false)
    })
})

// ─── classifyCommand ──────────────────────────────────────────────────────────

describe('classifyCommand', () => {
    it('should block rm -rf /', () => {
        expect(classifyCommand('rm -rf /')).toBe('block')
    })

    it('should block shutdown', () => {
        expect(classifyCommand('shutdown')).toBe('block')
    })

    it('should block fork bomb', () => {
        expect(classifyCommand(':(){:|:&};:')).toBe('block')
    })

    it('should require confirm for rm commands', () => {
        expect(classifyCommand('rm foo.txt')).toBe('confirm')
    })

    it('should require confirm for mv commands', () => {
        expect(classifyCommand('mv a.txt b.txt')).toBe('confirm')
    })

    it('should require confirm for kill commands', () => {
        expect(classifyCommand('kill 1234')).toBe('confirm')
    })

    it('should mark ls as safe', () => {
        expect(classifyCommand('ls -la')).toBe('safe')
    })

    it('should mark cat as safe', () => {
        expect(classifyCommand('cat file.txt')).toBe('safe')
    })

    it('should mark echo as safe', () => {
        expect(classifyCommand('echo hello')).toBe('safe')
    })

    it('should be case-insensitive', () => {
        expect(classifyCommand('SHUTDOWN')).toBe('block')
    })

    it('should trim whitespace', () => {
        expect(classifyCommand('  rm foo  ')).toBe('confirm')
    })
})

// ─── isSensitiveFile ──────────────────────────────────────────────────────────

describe('isSensitiveFile', () => {
    it('should detect .env', () => {
        expect(isSensitiveFile('.env')).toBe(true)
    })

    it('should detect .env.local', () => {
        expect(isSensitiveFile('.env.local')).toBe(true)
    })

    it('should detect id_rsa in any directory', () => {
        expect(isSensitiveFile('/home/user/.ssh/id_rsa')).toBe(true)
    })

    it('should detect id_ed25519', () => {
        expect(isSensitiveFile('id_ed25519')).toBe(true)
    })

    it('should detect .ssh/config via path suffix', () => {
        expect(isSensitiveFile('/home/user/.ssh/config')).toBe(true)
    })

    it('should detect .npmrc', () => {
        expect(isSensitiveFile('.npmrc')).toBe(true)
    })

    it('should not flag normal files', () => {
        expect(isSensitiveFile('index.ts')).toBe(false)
    })

    it('should not flag package.json', () => {
        expect(isSensitiveFile('package.json')).toBe(false)
    })
})
