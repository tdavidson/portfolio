// The registry is assembled from five independent manifests + handler maps. These guard
// the seams between them — the failures that would otherwise only show up as a 500 in
// front of an agent mid-conversation.

import { describe, it, expect } from 'vitest'
import { AGENT_TOOLS, getTool, isLedgerTool } from '@/lib/accounting/agent-tools'
import { isDraftOnlyCall, shouldStage } from '@/lib/agent/dispatch'
import { adminOnlyToolLabel } from '@/lib/access/admin-only'
import { isToolOffered } from '@/lib/agent/destructive'

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

  it('LP writes are the register, letter, portal and proposed-call tools, and issuing a call and publishing notices, which are always staged', () => {
    const writable = AGENT_TOOLS.filter(t => t.domain === 'lp' && t.scope === 'write')
    expect(writable.map(t => t.name).sort()).toEqual([
      'issue_capital_call', 'lp_add_document', 'lp_announce', 'lp_authorized_user_add', 'lp_authorized_user_remove',
      'lp_correct_commitment', 'lp_create_entity', 'lp_create_investor', 'lp_create_letter', 'lp_delete_commitment',
      'lp_delete_entity', 'lp_delete_investor', 'lp_document_upload_url', 'lp_draft_letter', 'lp_merge_investors',
      'lp_portal_account_status', 'lp_portal_invite', 'lp_portal_invite_bulk', 'lp_portal_resend_invite', 'lp_portal_settings',
      'lp_portal_unlink', 'lp_proposed_call_approve', 'lp_proposed_call_discard', 'lp_proposed_call_propose',
      'lp_proposed_call_revise', 'lp_record_commitment', 'lp_send_item', 'lp_share_letter', 'lp_update_entity',
      'lp_update_investor', 'lp_update_profile', 'lp_write_letter',
      'publish_call_notices',
    ])
    // What goes out to LPs is staged from any credential and approved in the app, gated like the
    // notices publish route.
    expect(getTool('publish_call_notices')).toMatchObject({ stagesAs: 'publish_call_notices', accessDomain: 'lp_relations', accessFeature: 'lp_portal' })
    expect(shouldStage(getTool('publish_call_notices')!, {}, { keyId: 'key_script' })).toBe(true)
    // Issuing a call is the Analyst's pending action, staged from any connection and approved by an admin.
    expect(getTool('issue_capital_call')).toMatchObject({ stagesAs: 'issue_capital_call', accessDomain: 'lp_capital' })
    expect(shouldStage(getTool('issue_capital_call')!, {}, { keyId: 'key_script' })).toBe(true)
    // Letters are the LP Letters pages': LP relations, under their switch.
    for (const t of writable.filter(t => t.name.endsWith('_letter'))) {
      expect(t, t.name).toMatchObject({ accessDomain: 'lp_relations', accessFeature: 'lp_letters' })
    }
    // LP portal documents are the LP documents settings': LP relations, under the portal switch, admin only.
    for (const name of ['lp_document_upload_url', 'lp_add_document']) {
      expect(getTool(name), name).toMatchObject({ accessDomain: 'lp_relations', accessFeature: 'lp_portal' })
    }
  })

  it('destructive tools are exactly the deletes, merges and book reversals, each admin-only and always staged', () => {
    const destructive = AGENT_TOOLS.filter(t => t.destructive)
    expect(destructive.map(t => t.name).sort()).toEqual([
      'delete_company', 'delete_lp_positions', 'diligence_delete_deal', 'lp_delete_commitment', 'lp_delete_entity', 'lp_delete_investor',
      'lp_merge_investors', 'merge_vehicles', 'remove_member', 'reverse_entry', 'unpost_entry', 'void_entry',
    ])
    for (const t of destructive) {
      expect(t.scope, t.name).toBe('write')
      expect(adminOnlyToolLabel(t.name, {}), t.name).toBeTruthy()
      // Staged from a script's key too, and never a draft-only call.
      expect(shouldStage(t, {}, { keyId: 'key_script' }), t.name).toBe(true)
      expect(isDraftOnlyCall(t, {}), t.name).toBe(false)
      expect(t.stagesAs, t.name).toBeUndefined()
      // Each says it is destructive, waits for an admin, and what cannot be undone.
      expect(t.description, t.name).toMatch(/DESTRUCTIVE/)
      expect(t.description, t.name).toMatch(/admin approves/)
      expect(t.description, t.name).toMatch(/cannot be undone/i)
    }
    // "Delete all fund data" is deliberately not a tool.
    expect(AGENT_TOOLS.some(t => /delete_(all|fund)/.test(t.name))).toBe(false)
  })

  it('reopen_period is always offered, admin-only, and staged from a chat', () => {
    const tool = getTool('reopen_period')!
    expect(tool.destructive).toBeUndefined()
    expect(isLedgerTool(tool)).toBe(true)
    expect(isToolOffered(tool)).toBe(true)
    expect(adminOnlyToolLabel('reopen_period', {})).toBeTruthy()
    expect(shouldStage(tool, {}, { keyId: 'oauth:abc' })).toBe(true)
  })

  it('document templates are fund-scoped, gated on LP letters, and only generating skips staging', () => {
    for (const name of ['document_template_get', 'document_template_save', 'document_generate']) {
      const tool = getTool(name)!
      expect(tool.domain, name).toBe('portfolio')
      expect(tool.accessDomain, name).toBe('lp_relations')
      expect(tool.accessFeature, name).toBe('lp_letters')
      expect(isLedgerTool(tool), name).toBe(false)
    }
    expect(getTool('document_template_get')!.scope).toBe('read')
    expect(isDraftOnlyCall(getTool('document_template_save')!, {})).toBe(false)
    expect(isDraftOnlyCall(getTool('document_generate')!, {})).toBe(true)
  })

  it('deal and diligence writes are named for their stage, and gated like their web routes', () => {
    const writes = AGENT_TOOLS.filter(t => ['diligence', 'deals'].includes(t.domain ?? '') && t.scope === 'write')
    expect(writes.length).toBeGreaterThan(0)
    for (const t of writes) {
      expect(t.name, t.name).toMatch(t.domain === 'deals' ? /^deals_/ : /^diligence_/)
      // Each takes the deal it changes by name or id, except the two that create one.
      // (and the deck upload URL, which is for a deal not created yet).
      if (!['deals_create_inbound', 'diligence_create_deal', 'deals_deck_upload_url'].includes(t.name)) {
        expect(t.inputSchema.required, t.name).toContain('deal')
      }
    }
    expect(getTool('deals_update_inbound')!.accessDomain).toBeUndefined()
    // Promoting creates a deal room, so it answers to diligence, as api/deals/[id]/promote-to-diligence does.
    expect(getTool('deals_promote_to_diligence')!.accessDomain).toBe('diligence')
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

  it('exposes budget & forecast as fund-scoped reads on accounting, with no switch of their own', () => {
    for (const name of ['forecast_list_plans', 'forecast_series', 'forecast_explain', 'forecast_variance', 'forecast_fee_links', 'forecast_suggest_rules']) {
      const tool = getTool(name)!
      expect(tool.scope, name).toBe('read')
      expect(tool.domain, name).toBe('portfolio')
      expect(tool.accessDomain, name).toBe('accounting')
      expect(tool.accessFeature, name).toBeUndefined()
      expect(tool.inputSchema.required, name).toContain('vehicle')
      expect(isLedgerTool(tool), name).toBe(false)
    }
    for (const name of ['forecast_create_plan', 'forecast_update_plan', 'forecast_publish', 'forecast_set_fee_link']) {
      const tool = getTool(name)!
      expect(tool.scope, name).toBe('write')
      expect(tool.accessFeature, name).toBeUndefined()
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
