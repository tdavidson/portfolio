import { describe, it, expect } from 'vitest'
import { foldDeclaredCarry, foldFlags, foldNoticePartners, foldPreviewCarry } from './distribution-carry-fold'
import { COMBINED_RECIPIENTS_ID, COMBINED_RECIPIENTS_NAME } from '@/lib/access/carry-visibility'

const recipients = new Set(['gp', 'jane'])

const preview = {
  method: 'waterfall',
  lines: [{ lpEntityId: 'lp1', amount: 60_000 }, { lpEntityId: 'lp2', amount: 30_000 }, { lpEntityId: 'gp', amount: 1_000 }],
  carryLines: [{ lpEntityId: 'gp', amount: 6_000 }, { lpEntityId: 'jane', amount: 3_000 }],
  lineBreakdown: [
    { lpEntityId: 'lp1', returnOfCapital: 50_000, preferred: 5_000, profit: 5_000 },
    { lpEntityId: 'gp', returnOfCapital: 1_000, preferred: 0, profit: 0 },
  ],
  names: { lp1: 'Acme LP', lp2: 'Northwind LP', gp: 'Example GP LLC', jane: 'Jane Doe' },
  terms: { kind: 'european', carryRate: 0.2, prefRate: 0.08, prefBase: 'contributed', recipients: ['gp', 'jane'] },
  checks: { missing: [], flags: [
    { code: 'gp_capital_and_carry', severity: 'warning', subject: 'gp', message: 'Example GP LLC receives 1000.00 and 6000.00' },
    { code: 'other', severity: 'warning', message: 'fund-level' },
  ] },
  warnings: [], tiers: {}, stateBefore: {}, stateAfter: {}, suggestedCharacter: {},
} as any

describe('foldPreviewCarry', () => {
  const p = foldPreviewCarry(preview, recipients)
  it('keeps the LPs, folds every recipient into one row per role, and still adds up', () => {
    expect(p.lines).toEqual([{ lpEntityId: 'lp1', amount: 60_000 }, { lpEntityId: 'lp2', amount: 30_000 }, { lpEntityId: COMBINED_RECIPIENTS_ID, amount: 1_000 }])
    expect(p.carryLines).toEqual([{ lpEntityId: COMBINED_RECIPIENTS_ID, amount: 9_000 }])
    expect(p.names[COMBINED_RECIPIENTS_ID]).toBe(COMBINED_RECIPIENTS_NAME)
    expect(JSON.stringify(p)).not.toMatch(/Jane Doe|Example GP LLC|\b6000\b|"jane"/)
  })
  it('restates a recipient check without their figures, and leaves fund-level checks alone', () => {
    expect(p.checks.flags.map(f => f.subject)).toEqual([COMBINED_RECIPIENTS_ID, undefined])
    expect(p.checks.flags[1].message).toBe('fund-level')
  })
  it('changes nothing when there is nobody to hide', () => {
    expect(foldPreviewCarry(preview, new Set())).toBe(preview)
  })
})

describe('foldDeclaredCarry', () => {
  const line = (o: any) => ({ id: o.lpEntityId + o.role, name: o.lpEntityId, character: { returnOfCapital: 0, realizedGain: o.amount, income: 0 }, settled: 0, outstanding: o.amount, status: 'unpaid', settledOn: null, noticeDocumentId: 'doc', ...o })
  const d = { distributionId: 'd1', lines: [
    line({ lpEntityId: 'lp1', role: 'lp', amount: 60_000 }),
    line({ lpEntityId: 'gp', role: 'carry', amount: 6_000 }),
    line({ lpEntityId: 'jane', role: 'carry', amount: 3_000, deductions: [{ amount: 100, description: 'Tax withheld' }] }),
  ] } as any
  it('folds recipients\' carry into one combined line with no notice', () => {
    const f = foldDeclaredCarry(d, recipients)
    expect(f.lines.map((l: any) => [l.lpEntityId, l.role, l.amount])).toEqual([['lp1', 'lp', 60_000], [COMBINED_RECIPIENTS_ID, 'carry', 9_000]])
    expect(f.lines[1].noticeDocumentId).toBeNull()
    expect(f.lines[1].deductions).toEqual([{ amount: 100, description: 'Deductions (combined)' }])
  })
})

describe('foldNoticePartners and foldFlags', () => {
  it('drops recipients\' addresses and names', () => {
    const base = { alreadyPublished: false, cc: [], via: 'portal' as const, unreachable: null }
    const out = foldNoticePartners([
      { ...base, lpEntityId: 'lp1', name: 'Acme LP', amount: 10, capital: 10, carry: 0, to: 'ops@acme.example' },
      { ...base, lpEntityId: 'jane', name: 'Jane Doe', amount: 5, capital: 0, carry: 5, to: 'jane@person.example' },
    ], recipients)
    expect(out[1]).toMatchObject({ lpEntityId: COMBINED_RECIPIENTS_ID, amount: 5, carry: 5, to: null, via: null })
    expect(foldFlags([{ code: 'not_emailed', severity: 'warning', subject: 'jane', message: 'Jane Doe: no email' }], recipients)[0].message).not.toMatch(/Jane/)
  })
})
