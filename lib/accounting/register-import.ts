// A capital call or distribution from a spreadsheet: each partner's amount, and what they have
// paid (or been paid) so far.
//
// Two halves. `parseRegisterSheet` (lib/accounting/register-sheet.ts, browser-safe) reads pasted rows (tab- or comma-separated, a header
// row naming the columns) into one line per partner, matched by name to the entity's partners, and
// says which rows it could not place. The form shows that and fills its own lines, so a person sees
// the call before anything is written. `recordRegisterPayments` runs after the call is issued or
// the distribution declared, through the normal path, and posts the payments the sheet recorded —
// the same entries a bank match posts (cash against Due from LPs for a call; the distribution
// payable against cash for a distribution). Each is tagged to its register line, so a retry of the
// same import posts nothing twice.

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildDistributionSettlementEntry, buildFundingEntry } from './entries'
import { accountIdByCode, persistEntry } from './persist'
import { DISTRIBUTION_PAYABLE_CODE, RECEIVABLE_CODE } from './chart'
import { roundCents } from './ledger'
import type { RegisterPayment } from './register-sheet'
export { parseMoney, parseRegisterSheet, parseSheetDate, type ParsedSheet, type RegisterPayment, type SheetLine, type SheetPartner } from './register-sheet'


/**
 * Post what the sheet says was paid against a just-issued call or just-declared distribution.
 * Each payment is capped at that partner's line, dated no earlier than the register, and tagged
 * `register-import:<register id>:<partner>` so the same import retried posts nothing twice.
 */
export async function recordRegisterPayments(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null,
  input: { kind: 'call' | 'distribution'; registerId: string; registerDate: string; lines: Map<string, number>; payments: RegisterPayment[] },
): Promise<{ posted: number } | { error: string }> {
  const payments = input.payments.filter(p => p && typeof p.lpEntityId === 'string' && Number(p.amount) > 0)
  if (payments.length === 0) return { posted: 0 }
  const codes = await accountIdByCode(admin, fundId, group)
  const cash = codes.get('1000')
  const other = codes.get(input.kind === 'call' ? RECEIVABLE_CODE : DISTRIBUTION_PAYABLE_CODE)
  if (!cash || !other) return { error: `The chart is missing ${!cash ? '1000 Cash' : input.kind === 'call' ? `${RECEIVABLE_CODE} Due from LPs` : `${DISTRIBUTION_PAYABLE_CODE} Distributions payable`}.` }

  const tag = (lp: string) => `register-import:${input.registerId}:${lp}`
  const { data: done } = await (admin as any).from('journal_entries').select('source_ref').eq('fund_id', fundId).eq('book', 'actual').like('source_ref', `register-import:${input.registerId}:%`)
  const already = new Set(((done as any[]) ?? []).map(r => r.source_ref as string))

  let posted = 0
  for (const p of payments) {
    const line = input.lines.get(p.lpEntityId)
    if (line == null) return { error: 'A payment names a partner who is not on this register.' }
    if (already.has(tag(p.lpEntityId))) continue
    const amount = roundCents(Math.min(Number(p.amount), line))
    const date = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.date >= input.registerDate ? p.date : input.registerDate
    const base = { fundId, entryDate: date, memo: input.kind === 'call' ? 'Capital call — funded (imported)' : 'Distribution — paid (imported)' }
    const entry = input.kind === 'call'
      ? buildFundingEntry(base, p.lpEntityId, amount, cash, other)
      : buildDistributionSettlementEntry(base, p.lpEntityId, amount, cash, other)
    const result = await persistEntry(admin, fundId, group, userId, { ...entry, sourceRef: tag(p.lpEntityId) }, 'posted')
    if ('error' in result) return { error: result.error }
    posted++
  }
  return { posted }
}
