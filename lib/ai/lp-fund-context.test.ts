import { describe, it, expect, vi } from 'vitest'

/**
 * The LP context block the Analyst reasons from.
 *
 * The block IS the Analyst's only view of LP capital — anything wrong or missing here is
 * something it will confidently state. Two things matter most: an LP holding across several
 * vehicles must roll up to ONE line (or the Analyst reports the same LP twice), and its IRR must
 * be withheld there, because IRRs don't sum across positions and a combined figure would be
 * fabricated rather than merely imprecise.
 */

const generateLiveReport = vi.hoisted(() => vi.fn())
vi.mock('@/lib/accounting/live-report', () => ({ generateLiveReport }))

import { buildLpContext } from './lp-fund-context'

const row = (over: Partial<any>) => ({
  entity_id: 'e1',
  portfolio_group: 'Fund IV',
  source: 'ledger',
  commitment: 0,
  called_capital: 0,
  paid_in_capital: 0,
  distributions: 0,
  nav: 0,
  total_value: 0,
  outstanding_balance: 0,
  receivable: 0,
  dpi: null,
  rvpi: null,
  tvpi: null,
  irr: null,
  ...over,
})

const admin = {} as any

describe('buildLpContext', () => {
  it('returns nothing when the fund has no LP positions — no empty scaffolding in the prompt', async () => {
    generateLiveReport.mockResolvedValue({ asOf: null, rows: [], vehicles: [], entityNames: new Map() })
    expect(await buildLpContext(admin, 'f1', null)).toBe('')
  })

  it('rolls one LP up across vehicles into a single line and withholds the combined IRR', async () => {
    generateLiveReport.mockResolvedValue({
      asOf: '2026-06-30',
      rows: [
        row({ entity_id: 'e1', portfolio_group: 'Fund IV', commitment: 4_000_000, paid_in_capital: 2_000_000, distributions: 500_000, nav: 2_500_000, outstanding_balance: 100_000, irr: 0.21 }),
        row({ entity_id: 'e1', portfolio_group: 'SPV II', commitment: 1_000_000, paid_in_capital: 1_000_000, distributions: 0, nav: 1_200_000, irr: 0.15 }),
        row({ entity_id: 'e2', portfolio_group: 'Fund IV', commitment: 500_000, paid_in_capital: 250_000, distributions: 0, nav: 300_000, irr: 0.11 }),
      ],
      vehicles: [{ group: 'Fund IV', source: 'ledger', lps: 2 }, { group: 'SPV II', source: 'tracked', lps: 1 }],
      entityNames: new Map([['e1', 'Cranmore Trust'], ['e2', 'Aldis Family Office']]),
    })

    const block = await buildLpContext(admin, 'f1', null)
    const lines = block.split('\n')
    const cranmore = lines.find(l => l.includes('Cranmore Trust'))!
    const aldis = lines.find(l => l.includes('Aldis Family Office'))!

    // One line, summed across both vehicles, naming both.
    expect(lines.filter(l => l.includes('Cranmore Trust'))).toHaveLength(1)
    expect(cranmore).toContain('commit 5000000.00')
    expect(cranmore).toContain('called 3000000.00')
    expect(cranmore).toContain('NAV 3700000.00')
    expect(cranmore).toContain('in Fund IV; SPV II')
    // Two positions, two IRRs, no honest combined one.
    expect(cranmore).toContain('IRR n/a (multi-vehicle)')
    expect(cranmore).not.toContain('21.0%')

    // A single-vehicle LP keeps its IRR, since there's nothing to combine.
    expect(aldis).toContain('IRR 11.0%')
    // DPI = distributions / called = 0 / 250000.
    expect(aldis).toContain('DPI 0.00x')

    expect(block).toContain('AS OF: 2026-06-30')
    expect(block).toContain('Fund IV (ledger, 2 LPs)')
    expect(block).toContain('FUND TOTALS: commit 5500000.00')
    expect(block).toContain('3250000.00') // called across the fund
  })

  it('labels a look-through position so it is not read as double-counting', async () => {
    generateLiveReport.mockResolvedValue({
      asOf: null,
      rows: [row({ entity_id: 'e3', portfolio_group: 'Fund IV', lookThroughVia: 'GP LLC', commitment: 100_000 })],
      vehicles: [{ group: 'Fund IV', source: 'ledger', lps: 1 }],
      entityNames: new Map([['e3', 'Partner A']]),
    })

    expect(await buildLpContext(admin, 'f1', null)).toContain('in Fund IV (via GP LLC)')
  })

  it('falls back to an id fragment rather than dropping an LP whose name is missing', async () => {
    generateLiveReport.mockResolvedValue({
      asOf: null,
      rows: [row({ entity_id: 'abcdef0123456789', commitment: 1 })],
      vehicles: [],
      entityNames: new Map(),
    })

    expect(await buildLpContext(admin, 'f1', null)).toContain('abcdef01:')
  })

  it('shows only the caller\'s entities — another entity\'s LPs and positions never reach the prompt', async () => {
    generateLiveReport.mockResolvedValue({
      asOf: '2026-06-30',
      rows: [
        row({ entity_id: 'e1', portfolio_group: 'Fund IV', commitment: 4_000_000 }),
        row({ entity_id: 'e1', portfolio_group: 'SPV II', commitment: 1_000_000 }),
        row({ entity_id: 'e2', portfolio_group: 'SPV II', commitment: 500_000 }),
      ],
      vehicles: [{ group: 'Fund IV', source: 'ledger', lps: 1 }, { group: 'SPV II', source: 'tracked', lps: 2 }],
      entityNames: new Map([['e1', 'Cranmore Trust'], ['e2', 'Aldis Family Office']]),
    })
    const block = await buildLpContext(admin, 'f1', ['Fund IV'])
    expect(block).toContain('Cranmore Trust')
    expect(block).not.toContain('Aldis Family Office')
    expect(block).not.toContain('SPV II')
    expect(block).not.toContain('1000000')
  })
})
