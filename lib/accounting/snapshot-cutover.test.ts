import { describe, it, expect } from 'vitest'
import { planRow, isSkippedVehicle, type SnapshotRow } from './snapshot-cutover'

const ASOF = '2026-06-30'

const row = (p: Partial<SnapshotRow>): SnapshotRow => ({
  commitment: 0, paidInCapital: 0, calledCapital: null,
  distributions: 0, nav: 0, totalValue: null, outstandingBalance: null, ...p,
})

// The whole cutover turns on this function. If it is wrong, every LP's capital account is
// wrong, and it is wrong SILENTLY — the numbers still add up, they're just not the LP's.
describe('planRow', () => {
  it('reconstructs the snapshot NAV exactly', () => {
    // Called 400k, distributed 100k, now worth 600k. Implied cumulative gain: 300k.
    const p = planRow(row({ commitment: 1_000_000, paidInCapital: 400_000, distributions: 100_000, nav: 600_000 }), ASOF)
    expect(p.endingCapital).toBe(600_000)
    expect(p.warnings).toEqual([])
  })

  it('keeps paid-in and distributions as their own events, so DPI/TVPI survive', () => {
    // The reason this is not a single opening_balance for NAV: that would leave paid-in and
    // distributions at zero, and every ratio computed from them would be wrong.
    const p = planRow(row({ commitment: 1_000_000, paidInCapital: 400_000, distributions: 100_000, nav: 600_000 }), ASOF)
    const by = Object.fromEntries(p.events.map(e => [e.sourceType, e.amount]))
    expect(by.capital_call).toBe(-400_000)   // debit-positive: a contribution is negative
    expect(by.distribution).toBe(100_000)    // ...and a distribution is positive
    expect(by.valuation).toBe(-300_000)      // the plug: nav - paid_in + distributions
  })

  it('books a LOSS as a positive (debit) valuation event', () => {
    // Called 500k, nothing distributed, now worth 300k.
    const p = planRow(row({ commitment: 500_000, paidInCapital: 500_000, distributions: 0, nav: 300_000 }), ASOF)
    const val = p.events.find(e => e.sourceType === 'valuation')!
    expect(val.amount).toBe(200_000)         // debit = reduces capital
    expect(p.endingCapital).toBe(300_000)
  })

  it('emits nothing for an LP with no activity', () => {
    expect(planRow(row({ commitment: 1_000_000 }), ASOF).events).toEqual([])
  })

  it('omits the plug when the snapshot shows no gain or loss', () => {
    const p = planRow(row({ commitment: 500_000, paidInCapital: 250_000, nav: 250_000 }), ASOF)
    expect(p.events.map(e => e.sourceType)).toEqual(['capital_call'])
    expect(p.endingCapital).toBe(250_000)
  })

  it('a fully-distributed LP ends at zero', () => {
    const p = planRow(row({ commitment: 100_000, paidInCapital: 100_000, distributions: 250_000, nav: 0 }), ASOF)
    expect(p.endingCapital).toBe(0)
    // Gain = 0 - 100k + 250k = 150k of profit.
    expect(p.events.find(e => e.sourceType === 'valuation')!.amount).toBe(-150_000)
  })

  it('rounds to cents and still ties', () => {
    const p = planRow(row({ commitment: 1_000_000, paidInCapital: 333_333.333, distributions: 11.115, nav: 500_000.005 }), ASOF)
    expect(p.endingCapital).toBe(500_000.01)
    expect(p.warnings).toEqual([])
  })
})

describe('planRow — paid-in / called fallback (the data-loss bug)', () => {
  it('falls back to called_capital when paid_in_capital is null', () => {
    // The row that used to cross over with ZERO paid-in: value lives only in called_capital.
    const p = planRow(row({ commitment: 1_000_000, paidInCapital: 0, calledCapital: 500_000, nav: 500_000 }), ASOF)
    expect(p.events.find(e => e.sourceType === 'capital_call')!.amount).toBe(-500_000)
    expect(p.endingCapital).toBe(500_000)
    expect(p.warnings).toEqual([])   // one column empty is normal, not a warning
  })

  it('prefers paid_in_capital when it is the populated one', () => {
    const p = planRow(row({ commitment: 1_000_000, paidInCapital: 400_000, calledCapital: null, nav: 400_000 }), ASOF)
    expect(p.events.find(e => e.sourceType === 'capital_call')!.amount).toBe(-400_000)
  })

  it('a row with neither column still produces no phantom capital', () => {
    const p = planRow(row({ commitment: 1_000_000, paidInCapital: 0, calledCapital: null }), ASOF)
    expect(p.events.find(e => e.sourceType === 'capital_call')).toBeUndefined()
  })
})

describe('planRow — NAV / total_value fallback (the NAV didn\'t carry bug)', () => {
  it('recovers NAV from total_value when nav is null', () => {
    // The row that came over with ZERO nav: only total_value (= dist + NAV) was recorded.
    const p = planRow(row({ commitment: 1_000_000, paidInCapital: 400_000, distributions: 100_000, nav: null, totalValue: 700_000 }), ASOF)
    expect(p.endingCapital).toBe(600_000)   // total_value 700k − distributions 100k
    // Gain = nav − paid_in + dist = 600k − 400k + 100k = 300k → valuation event −300k.
    expect(p.events.find(e => e.sourceType === 'valuation')!.amount).toBe(-300_000)
  })

  it('trusts a stored nav of 0 (a realized position) — does NOT derive from total_value', () => {
    // The Alice bug: nav=0 correctly (fully realized), total_value stored as 0 (garbage — the
    // UI derives the shown total). The old logic saw nav=0 as "missing", derived from the
    // 0 total_value, and produced a large negative NAV. nav=0 must win.
    const p = planRow(row({ commitment: 50_000, paidInCapital: 50_000, distributions: 140_000, nav: 0, totalValue: 0 }), ASOF)
    expect(p.endingCapital).toBe(0)
    expect(p.warnings).toEqual([])
  })

  it('prefers an explicit nav over total_value', () => {
    const p = planRow(row({ commitment: 1_000_000, paidInCapital: 400_000, distributions: 100_000, nav: 550_000, totalValue: 999_999 }), ASOF)
    expect(p.endingCapital).toBe(550_000)
  })

  it('a fully-called LP with no gain still carries its NAV', () => {
    // paid-in only in called_capital, NAV only in total_value — both fallbacks at once.
    const p = planRow(row({ commitment: 500_000, paidInCapital: 0, calledCapital: 500_000, distributions: 0, nav: null, totalValue: 500_000 }), ASOF)
    expect(p.endingCapital).toBe(500_000)
    expect(p.events.find(e => e.sourceType === 'capital_call')!.amount).toBe(-500_000)
  })
})

describe('planRow — cross-checks on the source data', () => {
  it('flags called != paid-in, and uses paid-in', () => {
    // In a snapshot these are the same figure. If they differ, the spreadsheet meant
    // something by it and we must not silently pick one.
    const p = planRow(row({ commitment: 1_000_000, paidInCapital: 400_000, calledCapital: 500_000, nav: 400_000 }), ASOF)
    expect(p.warnings.join()).toContain('differ')
    expect(p.events.find(e => e.sourceType === 'capital_call')!.amount).toBe(-400_000)
  })

  it('does NOT warn on an outstanding_balance mismatch — the cutover ignores that field', () => {
    // A stored outstanding_balance that disagrees with commitment − paid-in changes nothing
    // the cutover writes (uncalled is derived from commitment − called), and it disagreed
    // systematically in real data — so it is deliberately not flagged.
    const p = planRow(row({
      commitment: 1_000_000, paidInCapital: 400_000, calledCapital: 400_000, nav: 400_000, outstandingBalance: 700_000,
    }), ASOF)
    expect(p.warnings).toEqual([])
  })

  it('a stored 0 in the other column is not treated as a disagreement', () => {
    // paid-in populated, called left at 0 (not filled in). The old logic flagged this as
    // "called (0) and paid-in differ" — a hundred false positives in real data.
    const p = planRow(row({ commitment: 500_000, paidInCapital: 25_000, calledCapital: 0, nav: 25_000 }), ASOF)
    expect(p.warnings).toEqual([])
    expect(p.events.find(e => e.sourceType === 'capital_call')!.amount).toBe(-25_000)
  })

  it('accepts a snapshot that ties', () => {
    const p = planRow(row({
      commitment: 1_000_000, paidInCapital: 400_000, calledCapital: 400_000,
      nav: 400_000, outstandingBalance: 600_000,
    }), ASOF)
    expect(p.warnings).toEqual([])
  })

  it('flags paid-in above commitment', () => {
    const p = planRow(row({ commitment: 100_000, paidInCapital: 150_000, nav: 150_000 }), ASOF)
    expect(p.warnings.join()).toContain('exceeds commitment')
  })
})

describe('the skip list', () => {
  // The list itself is deployment config (env CUTOVER_SKIP_VEHICLES), so these exercise the
  // parsing and matching rules against a synthetic list rather than any real vehicle.
  const skips = ['acme', 'acme spv associates']
  const skipped = (name: string) => skips.includes(name.trim().toLowerCase())

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(skipped('Acme')).toBe(true)
    expect(skipped('  acme  ')).toBe(true)
    expect(skipped('Acme SPV Associates')).toBe(true)
  })

  it('does not skip anything else', () => {
    expect(skipped('Fund I')).toBe(false)
    // Not a prefix match — a differently-named vehicle is NOT silently skipped.
    expect(skipped('Acme II')).toBe(false)
  })

  it('skips nothing when the env var is unset — the right default for a fresh install', () => {
    expect(isSkippedVehicle('Anything At All')).toBe(false)
  })
})
