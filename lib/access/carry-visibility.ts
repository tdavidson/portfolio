// What a member without `gp_economics` may see of carried interest.
//
// The FUND's carry is not secret from them: what each LP is charged, the carried-interest line on an
// LP's capital account, and the General Partner's total are fund-level facts, the same ones the LPs
// themselves are told. What IS gp_economics is what each RECIPIENT earns — the carry partners, often
// individual people, named in the vehicle's carry terms. Their split of the carry is compensation.
//
// So the rule is about whose capital account, not which line: an LP's carry line is shown; a carry
// recipient's capital account is not shown on its own. Where partners are listed together the
// recipients are folded into one combined row, so the table still adds up to the balance sheet and
// the fund's total carry stays visible. A single recipient's statement is refused outright: it is
// nothing but that person's carry.

import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { loadCarryTerms } from '@/lib/accounting/carry'
import type { CapitalAccount } from '@/lib/accounting/capital-account'

export function seesIndividualCarry(access: AccessContext): boolean {
  return hasAccess(access, 'gp_economics', 'read')
}

/** The LP entities that RECEIVE carry in this vehicle, per its carry terms. */
export async function carryRecipientIds(admin: SupabaseClient, fundId: string, group: string): Promise<Set<string>> {
  const terms = await loadCarryTerms(admin, fundId, group)
  return new Set(terms.recipients.map(r => r.lpEntityId))
}

export const COMBINED_RECIPIENTS_ID = 'carry_recipients'
export const COMBINED_RECIPIENTS_NAME = 'Carry recipients (combined)'

/**
 * Partner rows with every carry recipient's row folded into one combined row, field by field.
 * `combined` is how many rows were folded (0 = nothing to hide; the rows come back unchanged).
 */
export function combineCarryRecipients<R extends CapitalAccount & { id: string; name: string }>(
  rows: R[], recipients: Set<string>,
): { rows: R[]; combined: number } {
  const folded = rows.filter(r => recipients.has(r.id))
  if (folded.length === 0) return { rows, combined: 0 }
  const kept = rows.filter(r => !recipients.has(r.id))
  const sum = { ...folded[0], id: COMBINED_RECIPIENTS_ID, name: COMBINED_RECIPIENTS_NAME } as R
  for (const key of Object.keys(folded[0]) as (keyof R)[]) {
    if (typeof folded[0][key] !== 'number') continue
    ;(sum as any)[key] = Math.round(folded.reduce((s, r) => s + (r[key] as unknown as number), 0) * 100) / 100
  }
  return { rows: [...kept, sum], combined: folded.length }
}

export class CarryRecipientStatementError extends Error {
  constructor(name: string) {
    super(`${name} receives carried interest in this vehicle, so their capital account is GP economics, which your access does not include.`)
  }
}
