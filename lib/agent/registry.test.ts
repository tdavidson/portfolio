// The registry is assembled from five independent manifests + handler maps. These guard
// the seams between them — the failures that would otherwise only show up as a 500 in
// front of an agent mid-conversation.

import { describe, it, expect } from 'vitest'
import { AGENT_TOOLS, getTool, isLedgerTool } from '@/lib/accounting/agent-tools'

describe('agent tool registry', () => {
  it('every tool has a unique name', () => {
    const names = AGENT_TOOLS.map(t => t.name)
    const dupes = names.filter((n, i) => names.indexOf(n) !== i)
    // A duplicate silently shadows: getTool() finds the first, so one domain's tool would
    // be dispatched to the other's handler.
    expect(dupes).toEqual([])
  })

  it('every tool has a handler and a JSON-Schema input contract', () => {
    for (const t of AGENT_TOOLS) {
      expect(typeof t.handler, t.name).toBe('function')
      expect(t.inputSchema, t.name).toBeTruthy()
      expect(t.inputSchema.type, t.name).toBe('object')
      expect(t.description.length, t.name).toBeGreaterThan(10)
    }
  })

  it('covers all five domains', () => {
    const domains = new Set(AGENT_TOOLS.map(t => t.domain ?? 'ledger'))
    expect(Array.from(domains).sort()).toEqual(['deals', 'diligence', 'ledger', 'lp', 'portfolio'])
  })

  // The one thing `domain` actually changes at dispatch. A ledger tool is scoped to one
  // set of books; everything else is fund-wide, and forcing it to resolve a single vehicle
  // would throw on any fund with more than one — making "list every deal" impossible.
  it('only ledger tools are vehicle-scoped', () => {
    for (const t of AGENT_TOOLS) {
      const scoped = isLedgerTool(t)
      expect(scoped, t.name).toBe((t.domain ?? 'ledger') === 'ledger')
    }
  })

  it('every tool that takes a vehicle declares it', () => {
    // Ledger tools get `vehicle` INJECTED by the registry, because the dispatcher resolves
    // one for them (ctx.portfolioGroup). Non-ledger tools get an empty portfolioGroup —
    // resolveVehicleForTool returns '' for them — so any that needs a vehicle must declare
    // it in its own schema and resolve it in its handler. A non-ledger tool that took a
    // vehicle WITHOUT declaring it would silently receive nothing.
    //
    // `lp_capital_summary` and friends legitimately require one: they read a single set of
    // books. That is not the same as being vehicle-SCOPED by the dispatcher.
    for (const t of AGENT_TOOLS) {
      const required: string[] = t.inputSchema.required ?? []
      if (required.includes('vehicle')) {
        expect(t.inputSchema.properties?.vehicle, `${t.name} requires a vehicle but does not declare it`).toBeTruthy()
        expect(isLedgerTool(t), `${t.name} must resolve its own vehicle`).toBe(false)
      }
    }
    for (const t of AGENT_TOOLS.filter(isLedgerTool)) {
      expect(t.inputSchema.properties?.vehicle, t.name).toBeTruthy()
    }
  })

  it('the new domains are read-only — no agent can mutate a deal or an LP record', () => {
    const writable = AGENT_TOOLS
      .filter(t => ['diligence', 'deals', 'lp'].includes(t.domain ?? ''))
      .filter(t => t.scope === 'write')
    expect(writable.map(t => t.name)).toEqual([])
  })

  it('the two kinds of "deal" are named apart', () => {
    // inbound_deals (screening) and diligence_deals (deal room) are different tables at
    // different stages of one funnel. A tool called `get_deal` would answer about the
    // wrong one roughly half the time.
    expect(getTool('get_deal')).toBeUndefined()
    expect(getTool('deals_list_inbound')).toBeTruthy()
    expect(getTool('diligence_list_deals')).toBeTruthy()
  })

  it('exposes the capabilities that were asked for', () => {
    for (const name of [
      'lp_snapshot', 'lp_live_report', 'lp_reconcile_snapshot', 'lp_statement',
      'diligence_ask', 'diligence_checklist', 'diligence_evidence',
      'deals_list_inbound',
      'portfolio_construction',
      'forecast_list_plans', 'forecast_series', 'forecast_explain', 'forecast_variance',
    ]) {
      expect(getTool(name), name).toBeTruthy()
    }
  })

  it('exposes budget & forecast as fund-scoped reads behind the budgeting switch', () => {
    for (const name of ['forecast_list_plans', 'forecast_series', 'forecast_explain', 'forecast_variance', 'forecast_fee_links']) {
      const tool = getTool(name)!
      expect(tool.scope, name).toBe('read')
      expect(tool.domain, name).toBe('portfolio')
      expect(tool.accessDomain, name).toBe('accounting')
      expect(tool.accessFeature, name).toBe('budgeting')
      expect(tool.inputSchema.required, name).toContain('vehicle')
      expect(isLedgerTool(tool), name).toBe(false)
    }
    for (const name of ['forecast_create_plan', 'forecast_update_plan', 'forecast_publish', 'forecast_set_fee_link']) {
      const tool = getTool(name)!
      expect(tool.scope, name).toBe('write')
      expect(tool.accessFeature, name).toBe('budgeting')
    }
  })

  it('exposes construction as a fund-scoped, accounting-read tool', () => {
    const tool = getTool('portfolio_construction')!
    expect(tool.scope).toBe('read')
    expect(tool.domain).toBe('portfolio')
    expect(tool.accessDomain).toBe('accounting')
    expect(tool.inputSchema.required).toEqual(['vehicle'])
    expect(isLedgerTool(tool)).toBe(false)
  })
})
