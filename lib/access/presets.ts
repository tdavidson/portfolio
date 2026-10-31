// Role presets: a starting set of grants for the kinds of people a fund gives access to.
//
// A preset is a shortcut for the access grid, not a role the resolver knows about. Applying one
// writes an ordinary grant per area, and the admin can change any cell afterwards; nothing in
// `effectiveAccess` reads a preset. Admin-only operations (lib/access/admin-only.ts) stay admin-only
// whatever a preset grants. GPs who approve those are admins, which is a role, not a preset.
//
// Why each one looks the way it does is in the comment beside it.

import type { Domain } from './domains'
import type { AccessLevel } from './effective'

export type PresetKey = 'cfo' | 'fund_admin' | 'tax' | 'auditor' | 'investment_team' | 'investor_relations'

export interface AccessPreset {
  key: PresetKey
  label: string
  description: string
  /** Every grantable area, so applying a preset leaves nothing on a stale grant. */
  grants: Record<Exclude<Domain, 'admin'>, AccessLevel>
}

const NONE: AccessPreset['grants'] = {
  portfolio: 'none', relationships: 'none', dealflow: 'none', diligence: 'none', accounting: 'none',
  management_company: 'none', lp_capital: 'none', gp_economics: 'none', lp_relations: 'none', compliance: 'none',
  tax: 'none',
}

export const ACCESS_PRESETS: AccessPreset[] = [
  {
    // Runs the books and LP capital end to end. No candid deal notes or pipeline.
    key: 'cfo',
    label: 'CFO',
    description: 'Changes everything financial; reads the portfolio. Make them an admin to approve admin-only changes.',
    grants: {
      ...NONE, portfolio: 'read', accounting: 'write', management_company: 'write', lp_capital: 'write',
      gp_economics: 'write', lp_relations: 'write', compliance: 'write', tax: 'write',
    },
  },
  {
    // An outside administrator: keeps the books, computes allocations and carry, prepares notices
    // and statements. An admin publishes them. Not the management company's own books.
    key: 'fund_admin',
    label: 'Fund administrator',
    description: 'Keeps the fund books, LP capital and carry, and prepares LP documents for an admin to publish.',
    grants: {
      ...NONE, portfolio: 'read', accounting: 'write', lp_capital: 'write', gp_economics: 'write',
      lp_relations: 'write', compliance: 'read', tax: 'write',
    },
  },
  {
    // Reads the ledger, partner capital and carry, and does the tax work in the Tax area:
    // book-to-tax adjustments, the tax-year close, K-1 packages and partner tax forms. Proposes
    // journal entries to the books (drafts someone with write posts or rejects) but never posts
    // them. Finalizing, amending and delivering K-1s, and reopening a closed tax year, are
    // admin-only.
    key: 'tax',
    label: 'Tax preparer',
    description: 'Reads the books, partner capital and carry, proposes journal entries, posts tax adjustments and prepares K-1s. An admin finalizes and delivers them.',
    grants: {
      ...NONE, portfolio: 'read', accounting: 'propose', management_company: 'read', lp_capital: 'read',
      gp_economics: 'read', compliance: 'read', tax: 'write',
    },
  },
  {
    // Every financial area and what was sent to LPs, read-only, plus proposed audit adjustments:
    // draft journal entries someone with write posts or rejects. The audit trail is on each
    // entity's Admin page under Fund accounting.
    key: 'auditor',
    label: 'Auditor',
    description: 'Reads every financial area and LP document, and the audit trail, and proposes journal entries. Changes nothing directly.',
    grants: {
      ...NONE, portfolio: 'read', accounting: 'propose', management_company: 'read', lp_capital: 'read',
      gp_economics: 'read', lp_relations: 'read', compliance: 'read', tax: 'read',
    },
  },
  {
    // Works companies, notes, deals and diligence. No LP or GP economics.
    key: 'investment_team',
    label: 'Investment team',
    description: 'Works the portfolio, notes, deals and diligence. No access to the books or LPs.',
    grants: { ...NONE, portfolio: 'write', relationships: 'write', dealflow: 'write', diligence: 'write' },
  },
  {
    // LP letters, documents and the portal; reads LP capital to answer LP questions.
    key: 'investor_relations',
    label: 'Investor relations',
    description: 'Prepares LP letters and documents and reads LP capital. An admin sends and shares them.',
    grants: { ...NONE, portfolio: 'read', lp_capital: 'read', lp_relations: 'write', compliance: 'write' },
  },
]

export function getPreset(key: unknown): AccessPreset | undefined {
  return ACCESS_PRESETS.find(p => p.key === key)
}
