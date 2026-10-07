import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TABLE_RULES } from './table-domains'

/**
 * Every portfolio and accounting table either carries the entity rule in RLS
 * (20261007100200_entity_rls.sql — the migration picks the predicate from the table's columns) or
 * is exempt here with the reason. A new table in these domains fails this test until someone
 * decides which — the same shape as the domain registry's own test.
 */
const EXEMPT: Record<string, string> = {
  default_metrics: 'fund-wide metric templates, no entity data',
  default_metric_exclusions: 'fund-wide metric template settings, no entity data',
  ask_response_overrides: 'fund-wide AI answer overrides, no entity data',
  vendors: 'fund-wide vendor directory, no entity data',
  crypto_wallet_balances: 'keyed by wallet — readable only through crypto_wallets (phase 3 tightens the join)',
  price_observations: 'keyed by feed — public market prices, not position data',
  lp_snapshots: 'fund-wide snapshot headers (name, date); their rows are lp_investments, which carry the rule',
  lp_letter_templates: 'fund-wide letter templates, no entity data',
  lp_onboarding_item_documents: 'keyed by onboarding item — readable through lp_onboarding_items, which carries the rule',
  intercompany_transactions: 'management-company domain; phase 2 with the LP and manco surfaces',
}

function rlsTables(): string[] {
  return ['20261007100200_entity_rls.sql', '20261007100300_entity_rls_lp.sql'].flatMap(file => {
    const sql = readFileSync(`supabase/migrations/${file}`, 'utf8')
    const start = sql.indexOf('tables text[] := array[')
    const block = sql.slice(start, sql.indexOf('];', start))
    return Array.from(block.matchAll(/'([a-z_0-9]+)'/g)).map(m => m[1])
  })
}

describe('entity RLS coverage', () => {
  it('covers or exempts every portfolio and accounting table', () => {
    const covered = new Set(rlsTables())
    const domainTables = Object.entries(TABLE_RULES)
      .filter(([, rule]) => 'domain' in rule && ['portfolio', 'accounting', 'management_company', 'lp_capital', 'lp_relations', 'gp_economics'].includes((rule as any).domain))
      .map(([t]) => t)
    const missing = domainTables.filter(t => !covered.has(t) && !(t in EXEMPT))
    expect(missing, `add these to 20261007100200's list (or a later migration) or exempt them with a reason`).toEqual([])
  })

  it('keeps the exemptions honest', () => {
    const covered = new Set(rlsTables())
    expect(Object.keys(EXEMPT).filter(t => covered.has(t))).toEqual([])
  })
})
