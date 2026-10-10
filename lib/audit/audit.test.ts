import { describe, expect, it } from 'vitest'
import { approvalDecision } from '@/lib/accounting/close-approval'
import { auditCsv, visibleTo } from './read'
import { auditReason } from './events'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

describe('approving a close', () => {
  it('needs a second member when there is one', () => {
    expect(approvalDecision('alice', 'bob', ['alice', 'bob'])).toEqual({ ok: true, selfApproved: false })
    const own = approvalDecision('alice', 'alice', ['alice', 'bob'])
    expect(own.ok).toBe(false)
  })

  it('lets the only member who can do the books approve their own close, and says so', () => {
    expect(approvalDecision('alice', 'alice', ['alice'])).toEqual({ ok: true, selfApproved: true })
  })
})

describe('reading the audit trail', () => {
  const ctx = (grants: Record<string, string>) => ({
    fundId: 'f', userId: 'u', role: 'member', features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone', lp_tracking: 'everyone', gp_economics: 'everyone' }, grants, defaults: {}, vehicles: { all: true, ids: [] },
  }) as any

  it('keeps K-1 events from a caller without the carry; partner events follow the books', () => {
    // Reading the books implies reading partner capital (DOMAIN_META.lp_capital.impliedBy).
    const books = visibleTo(ctx({ accounting: 'read' }))
    expect(books('entry.void')).toBe(true)
    expect(books('commitment.edit')).toBe(true)
    expect(books('k1.finalize')).toBe(false)
    expect(visibleTo(ctx({ accounting: 'read', gp_economics: 'read' }))('k1.finalize')).toBe(true)
  })

  it('writes a CSV an auditor can open, quoting what needs quoting', () => {
    const csv = auditCsv([{
      id: '1', createdAt: '2026-10-10T12:00:00Z', action: 'entry.void', subjectType: 'journal_entry', subjectId: 'e1',
      vehicleId: 'v1', actorId: 'u1', actorName: 'Alex', reason: 'Duplicate, see #12', details: { memo: 'Legal, Q3' },
    }], new Map([['v1', 'Fund I']]))
    expect(csv.split('\n')[1]).toBe('2026-10-10T12:00:00Z,Fund I,Alex,entry.void,journal_entry,e1,"Duplicate, see #12","{""memo"":""Legal, Q3""}"')
  })

  it('takes a typed reason, and treats a blank one as none', () => {
    expect(auditReason('  wrong account  ')).toBe('wrong account')
    expect(auditReason('   ')).toBeNull()
    expect(auditReason(undefined)).toBeNull()
  })
})
