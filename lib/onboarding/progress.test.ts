import { describe, it, expect } from 'vitest'
import {
  computeSetupProgress,
  primaryVehicle,
  progressCounts,
  type SetupFacts,
  type SetupAbilities,
  type SetupVehicleFacts,
  type SetupStep,
} from './progress'

const ALL: SetupAbilities = {
  isAdmin: true,
  portfolio: true,
  investments: true,
  imports: true,
  accounting: true,
  lpCapital: true,
  lpPortal: true,
  gpEconomics: true,
}

const EMPTY_VEHICLE: SetupVehicleFacts = {
  id: 'v1',
  name: 'Fund I',
  kind: 'fund',
  vintageYear: null,
  hasWaterfallTerms: false,
  hasAccountingSettings: false,
  partnerCount: 0,
  partnersWithCommitment: 0,
  investmentTxnCount: 0,
  ledgerInvestmentAccounts: 0,
  chartAccounts: 0,
  postedEntries: 0,
  draftEntries: 0,
  closedPeriods: 0,
  forecastPlans: 0,
}

function facts(over: Partial<SetupFacts> = {}, vehicle: Partial<SetupVehicleFacts> | null = {}): SetupFacts {
  const v = vehicle === null ? null : { ...EMPTY_VEHICLE, ...vehicle }
  return {
    can: ALL,
    settings: {
      hasAiKey: false,
      aiMode: null,
      productsChosen: false,
      activeProducts: [],
      inboundProvider: null,
      inboundConfigured: false,
      senderCount: 0,
    },
    vehicles: v ? [{ id: v.id, name: v.name, kind: v.kind }] : [],
    vehicle: v,
    lpEntityCount: 0,
    companyCount: 0,
    lpPortalLinks: 0,
    ...over,
  }
}

const steps = (f: SetupFacts) => computeSetupProgress(f).sections.flatMap(s => s.steps)
const step = (f: SetupFacts, key: SetupStep['key']) => steps(f).find(s => s.key === key)

describe('computeSetupProgress — order and sections', () => {
  it('lists the sections in setup order, all of them for an admin with everything on', () => {
    expect(computeSetupProgress(facts()).sections.map(s => s.key)).toEqual([
      'basics', 'fund', 'investors', 'investments', 'books', 'planning', 'integrations',
    ])
  })

  it('counts done over everything that applies', () => {
    const p = computeSetupProgress(facts({}, { vintageYear: 2026, hasWaterfallTerms: true, hasAccountingSettings: true }))
    // entity + fund terms are done
    expect(p.done).toBe(2)
    expect(p.total).toBe(steps(facts()).length)
    expect(p.complete).toBe(false)
  })

  it('is complete when every applicable step is done', () => {
    const p = computeSetupProgress(facts(
      {
        settings: { hasAiKey: true, aiMode: 'server_key', productsChosen: true, activeProducts: ['Portfolio Reporting'], inboundProvider: 'postmark', inboundConfigured: true, senderCount: 2 },
        lpPortalLinks: 3,
      },
      {
        vintageYear: 2024, hasWaterfallTerms: true, hasAccountingSettings: true,
        partnerCount: 4, partnersWithCommitment: 4, investmentTxnCount: 5, ledgerInvestmentAccounts: 5,
        postedEntries: 10, closedPeriods: 1, forecastPlans: 1,
      },
    ))
    expect(p.complete).toBe(true)
    expect(p.done).toBe(p.total)
  })
})

describe('computeSetupProgress — blocked and done', () => {
  it('blocks everything per-entity when there is no entity, and says why', () => {
    const f = facts({}, null)
    expect(step(f, 'entity')?.status).toBe('todo')
    const lps = step(f, 'lps')!
    expect(lps.status).toBe('blocked')
    expect(lps.dependsOn).toBe('entity')
    expect(lps.blockedBy).toBe('a fund entity')
    // The per-entity book steps cannot exist without an entity to point at.
    expect(step(f, 'open_books')).toBeUndefined()
    expect(step(f, 'fund_terms')).toBeUndefined()
  })

  it('blocks the first close and the forecast until the books are open', () => {
    const f = facts()
    expect(step(f, 'open_books')?.status).toBe('todo')
    expect(step(f, 'first_close')?.status).toBe('blocked')
    expect(step(f, 'first_close')?.blockedBy).toBe('open books')
    expect(step(f, 'forecast')?.status).toBe('blocked')

    const open = facts({}, { postedEntries: 3 })
    expect(step(open, 'open_books')?.status).toBe('done')
    expect(step(open, 'first_close')?.status).toBe('todo')
    expect(step(open, 'forecast')?.status).toBe('todo')
  })

  it('treats data as truth over order: a done step stays done even if its prerequisite is not', () => {
    const f = facts({}, { closedPeriods: 1, postedEntries: 0 })
    expect(step(f, 'first_close')?.status).toBe('done')
  })

  it('needs a commitment, not just a partner, for the LP step', () => {
    const f = facts({}, { partnerCount: 12, partnersWithCommitment: 0 })
    expect(step(f, 'lps')?.status).toBe('todo')
    expect(step(f, 'lps')?.detail).toBe('12 partners, 12 without a commitment')
    const g = facts({}, { partnerCount: 12, partnersWithCommitment: 9 })
    expect(step(g, 'lps')?.status).toBe('done')
    expect(step(g, 'lps')?.detail).toBe('12 partners, 3 without a commitment')
  })

  it('blocks portal invites on LPs, and senders on inbound email', () => {
    const f = facts()
    expect(step(f, 'lp_portal')?.status).toBe('blocked')
    expect(step(f, 'lp_portal')?.dependsOn).toBe('lps')
    expect(step(f, 'senders')?.status).toBe('blocked')
    expect(step(f, 'senders')?.dependsOn).toBe('inbound_email')
  })

  it('blocks "put on the ledger" until investments are recorded', () => {
    expect(step(facts(), 'investments_on_ledger')?.status).toBe('blocked')
    expect(step(facts({}, { investmentTxnCount: 4 }), 'investments_on_ledger')?.status).toBe('todo')
  })

  it('lists what is missing from the fund terms', () => {
    const f = facts({}, { vintageYear: 2025 })
    expect(step(f, 'fund_terms')?.detail).toBe('Not set yet: carry / waterfall, allocation basis')
  })

  it('does not ask about carry when the viewer cannot see GP economics', () => {
    const f = facts({ can: { ...ALL, gpEconomics: false } }, { vintageYear: 2025, hasWaterfallTerms: null, hasAccountingSettings: true })
    expect(step(f, 'fund_terms')?.status).toBe('done')
  })

  it('needs a finished inbound setup, not just a chosen provider', () => {
    const f = facts({ settings: { ...facts().settings!, inboundProvider: 'resend', inboundConfigured: false } })
    expect(step(f, 'inbound_email')?.status).toBe('todo')
    expect(step(f, 'inbound_email')?.detail).toBe('Resend, not finished')
  })

  it('marks LP and investment steps not applicable for a management company, and leaves them out of the count', () => {
    const f = facts({}, { kind: 'manco' })
    expect(step(f, 'lps')?.status).toBe('not_applicable')
    expect(step(f, 'investments')?.status).toBe('not_applicable')
    expect(step(f, 'fund_terms')?.status).toBe('not_applicable')
    const p = computeSetupProgress(f)
    expect(p.total).toBe(steps(f).filter(s => s.status !== 'not_applicable').length)
  })

  it('offers the three ways to open the books, on the selected entity', () => {
    const s = step(facts({}, { id: 'abc' }), 'open_books')!
    expect(s.options?.map(o => o.href)).toEqual([
      '/funds/abc/capital-accounts',
      '/funds/abc/opening-balances',
      '/funds/abc/migrate',
    ])
    expect(step(facts({}, { id: 'abc' }), 'first_close')?.href).toBe('/funds/abc/periods')
    expect(step(facts({}, { id: 'abc' }), 'forecast')?.href).toBe('/funds/abc/forecast')
  })
})

describe('computeSetupProgress — how AI works here', () => {
  const settings = facts().settings!

  it('asks until an admin chooses', () => {
    expect(step(facts(), 'ai_key')?.status).toBe('todo')
  })

  it('is done with a server key', () => {
    expect(step(facts({ settings: { ...settings, hasAiKey: true, aiMode: 'server_key' } }), 'ai_key')?.status).toBe('done')
  })

  it('is done with no key when the admin chose their own assistant', () => {
    const s = step(facts({ settings: { ...settings, aiMode: 'assistant' } }), 'ai_key')
    expect(s?.status).toBe('done')
    expect(s?.detail).toMatch(/your own assistant/)
  })
})

describe('computeSetupProgress — product and access filtering', () => {
  it('shows a member no admin-only steps', () => {
    const f = facts({ can: { ...ALL, isAdmin: false }, settings: null })
    const keys = steps(f).map(s => s.key)
    expect(keys).not.toContain('ai_key')
    expect(keys).not.toContain('products')
    expect(keys).not.toContain('entity')
    expect(keys).not.toContain('inbound_email')
    expect(keys).not.toContain('senders')
    expect(steps(f).some(s => s.adminOnly)).toBe(false)
  })

  it('hides every book step when accounting is not visible', () => {
    const f = facts({ can: { ...ALL, accounting: false } })
    const keys = steps(f).map(s => s.key)
    for (const k of ['fund_terms', 'investments_on_ledger', 'open_books', 'first_close', 'forecast']) {
      expect(keys).not.toContain(k)
    }
    expect(computeSetupProgress(f).sections.map(s => s.key)).not.toContain('books')
    expect(computeSetupProgress(f).sections.map(s => s.key)).not.toContain('planning')
    // Adding an entity falls back to Investments.
    expect(step(f, 'entity')?.href).toBe('/investments')
  })

  it('hides LP steps when LP reporting is not visible', () => {
    const f = facts({ can: { ...ALL, lpCapital: false, lpPortal: false } })
    expect(computeSetupProgress(f).sections.map(s => s.key)).not.toContain('investors')
  })

  it('hides inbound email unless portfolio reporting is on', () => {
    const f = facts({ can: { ...ALL, portfolio: false } })
    expect(computeSetupProgress(f).sections.map(s => s.key)).not.toContain('integrations')
  })

  it('a member with only portfolio sees only the investments step', () => {
    const f = facts({
      can: { isAdmin: false, portfolio: true, investments: true, imports: true, accounting: false, lpCapital: false, lpPortal: false, gpEconomics: false },
      settings: null,
    })
    expect(steps(f).map(s => s.key)).toEqual(['investments'])
    expect(step(f, 'investments')?.href).toBe('/import')
  })
})

describe('progressCounts', () => {
  it('drops skipped, unfinished steps from the total', () => {
    const p = computeSetupProgress(facts())
    const base = progressCounts(p)
    expect(base.total).toBe(p.total)
    const skipped = progressCounts(p, new Set(['forecast', 'senders']))
    expect(skipped.total).toBe(p.total - 2)
  })

  it('never lets a skip un-count a step that is done', () => {
    const p = computeSetupProgress(facts({}, { postedEntries: 1 }))
    const c = progressCounts(p, new Set(['open_books']))
    expect(c.done).toBe(p.done)
  })
})

describe('primaryVehicle', () => {
  it('prefers the first fund, then any non-manco, then anything', () => {
    expect(primaryVehicle([{ id: 'a', kind: 'spv' }, { id: 'b', kind: 'fund' }])?.id).toBe('b')
    expect(primaryVehicle([{ id: 'm', kind: 'manco' }, { id: 's', kind: 'spv' }])?.id).toBe('s')
    expect(primaryVehicle([{ id: 'm', kind: 'manco' }])?.id).toBe('m')
    expect(primaryVehicle([])).toBeNull()
  })
})
