/**
 * @file Unit tests for ApprovalManager (Phase 4).
 *
 * Tests: check (non-mutating auto-pass, mutating requires approval),
 *        recordDecision, policies (always/once/session),
 *        clearOnceApprovals, dispose, generateFingerprint
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ApprovalManager, generateFingerprint } from './approval.js'

// ─── generateFingerprint ──────────────────────────────────────────────────────

describe('generateFingerprint', () => {
    it('should produce stable fingerprint for same input', () => {
        const fp1 = generateFingerprint('bash', { command: 'ls' })
        const fp2 = generateFingerprint('bash', { command: 'ls' })
        expect(fp1).toBe(fp2)
    })

    it('should be order-independent for object keys', () => {
        const fp1 = generateFingerprint('tool', { a: 1, b: 2 })
        const fp2 = generateFingerprint('tool', { b: 2, a: 1 })
        expect(fp1).toBe(fp2)
    })

    it('should differ for different tool names', () => {
        const fp1 = generateFingerprint('bash', { command: 'ls' })
        const fp2 = generateFingerprint('write_file', { command: 'ls' })
        expect(fp1).not.toBe(fp2)
    })

    it('should handle null/undefined input', () => {
        const fp1 = generateFingerprint('tool', null)
        const fp2 = generateFingerprint('tool', undefined)
        expect(fp1).toBe(fp2)
    })
})

// ─── ApprovalManager ──────────────────────────────────────────────────────────

describe('ApprovalManager', () => {
    let manager: ApprovalManager

    beforeEach(() => {
        manager = new ApprovalManager()
    })

    // ── Non-mutating auto-pass ──

    it('should auto-pass non-mutating tools', () => {
        const result = manager.check('read_file', { path: 'x' }, false)
        expect(result.needsApproval).toBe(false)
    })

    it('should default to once policy', () => {
        expect(manager.policy).toBe('once')
    })

    it('should require approval for mutating tools', () => {
        const result = manager.check('write_file', { path: 'x' }, true)
        expect(result.needsApproval).toBe(true)
        if (result.needsApproval) {
            expect(result.toolName).toBe('write_file')
            expect(result.fingerprint).toBeTruthy()
        }
    })

    it('should cache approval under once policy', () => {
        const r1 = manager.check('bash', { command: 'ls' }, true)
        if (r1.needsApproval) manager.recordDecision(r1.fingerprint, 'approve')
        const r2 = manager.check('bash', { command: 'ls' }, true)
        expect(r2.needsApproval).toBe(false)
    })

    it('should clear once approvals on clearOnceApprovals', () => {
        const r1 = manager.check('bash', { command: 'ls' }, true)
        if (r1.needsApproval) manager.recordDecision(r1.fingerprint, 'approve')
        manager.clearOnceApprovals()
        const r2 = manager.check('bash', { command: 'ls' }, true)
        expect(r2.needsApproval).toBe(true)
    })

    it('should always require approval under always policy', () => {
        manager = new ApprovalManager({ policy: 'always' })
        const r1 = manager.check('bash', { command: 'ls' }, true)
        if (r1.needsApproval) manager.recordDecision(r1.fingerprint, 'approve')
        const r2 = manager.check('bash', { command: 'ls' }, true)
        expect(r2.needsApproval).toBe(true)
    })

    it('should persist approval across turns under session policy', () => {
        manager = new ApprovalManager({ policy: 'session' })
        const r1 = manager.check('bash', { cmd: 'ls' }, true)
        if (r1.needsApproval) manager.recordDecision(r1.fingerprint, 'approve')
        manager.clearOnceApprovals() // simulate turn end
        const r2 = manager.check('bash', { cmd: 'ls' }, true)
        expect(r2.needsApproval).toBe(false)
    })

    it('should not cache denied decisions', () => {
        const r1 = manager.check('bash', { command: 'ls' }, true)
        if (r1.needsApproval) manager.recordDecision(r1.fingerprint, 'deny')
        const r2 = manager.check('bash', { command: 'ls' }, true)
        expect(r2.needsApproval).toBe(true)
    })

    it('should clear all caches on dispose', () => {
        manager = new ApprovalManager({ policy: 'session' })
        const r1 = manager.check('bash', { cmd: 'ls' }, true)
        if (r1.needsApproval) manager.recordDecision(r1.fingerprint, 'approve')
        manager.dispose()
        const r2 = manager.check('bash', { cmd: 'ls' }, true)
        expect(r2.needsApproval).toBe(true)
    })

    it('should clear cache when switching policy', () => {
        const r1 = manager.check('bash', { cmd: 'ls' }, true)
        if (r1.needsApproval) manager.recordDecision(r1.fingerprint, 'approve')
        manager.policy = 'always'
        const r2 = manager.check('bash', { cmd: 'ls' }, true)
        expect(r2.needsApproval).toBe(true)
    })
})
