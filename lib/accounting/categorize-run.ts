// Run AI categorization over staged bank transactions and apply the results by
// re-pointing each draft entry's non-cash posting. Shared by the REST route and
// the agent tool. Only touches simple two-line bank drafts — an entry that's
// been turned into an allocated capital call (many postings) is left alone.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createFundAIProviderWithOverride } from '@/lib/ai'
import { loadPostedLedger } from './load'
import { RECEIVABLE_CODE, DISTRIBUTION_PAYABLE_CODE } from './chart'
import { accountIdByCode } from './persist'
import { vehicleIdByName } from './vehicle-id'
import { buildCategorizePrompt, parseCategorizations, type TxnToCategorize } from './categorize-ai'
import { ENTRY_SOURCE_TYPES } from './source-types'
import { ACTUAL_BOOK } from './books'

export interface CategorizeResult {
  considered: number
  updated: number
  errors: string[]
}

export async function runCategorization(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  ids?: string[]
): Promise<CategorizeResult | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  let q = admin
    .from('bank_transactions' as any)
    .select('id, journal_entry_id, txn_date, amount, description')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('status', 'drafted')
    // Leave rows that auto-matching already settled against a declared call (1300) or
    // distribution (2300). Those are attributed to a specific partner from a real
    // obligation; letting the categorizer re-point them to a guessed expense account
    // would silently undo a correct attribution.
    .not('suggested_account_code', 'in', `(${RECEIVABLE_CODE},${DISTRIBUTION_PAYABLE_CODE})`)
  if (ids && ids.length) q = q.in('id', ids)
  const { data: rows } = await q
  const txns = (rows as any[]) ?? []
  if (txns.length === 0) return { considered: 0, updated: 0, errors: [] }

  const { accounts } = await loadPostedLedger(admin, fundId, group)
  if (accounts.length === 0) return { error: "This entity has no chart of accounts yet. Import its bank transactions, or open its Admin → Chart of accounts." }
  const codes = await accountIdByCode(admin, fundId, group)
  const cashId = codes.get('1000')

  const toCategorize: TxnToCategorize[] = txns.map(t => ({ id: t.id, date: t.txn_date, amount: Number(t.amount), description: t.description ?? '' }))
  const { system, content } = buildCategorizePrompt(accounts, toCategorize)

  let provider
  try {
    provider = await createFundAIProviderWithOverride(admin, fundId)
  } catch (e) {
    return { error: `AI provider not configured: ${(e as Error).message}` }
  }

  let parsed
  try {
    const result = await provider.provider.createMessage({ model: provider.model, maxTokens: 2000, system, content })
    parsed = parseCategorizations(result.text)
  } catch (e) {
    return { error: `AI categorization failed: ${(e as Error).message}` }
  }

  const byId = new Map(parsed.map(c => [c.id, c]))
  const errors: string[] = []
  let updated = 0

  for (const t of txns) {
    const cat = byId.get(t.id)
    if (!cat) continue
    const newAccountId = codes.get(cat.accountCode)
    if (!newAccountId) { errors.push(`${t.id}: unknown account ${cat.accountCode}`); continue }

    // VALIDATE THE MODEL'S source_type. It was written through verbatim, but `source_type`
    // drives which line of the capital-account roll-forward a posting lands on — so a
    // hallucinated value ("capital_contribution", "misc") silently fell into `unclassified`
    // and distorted every LP statement it touched.
    if (!ENTRY_SOURCE_TYPES.includes(cat.sourceType)) {
      errors.push(`${t.id}: the model returned an unknown source type "${cat.sourceType}"`)
      continue
    }

    // Re-read the entry and confirm it is STILL a draft. The categorization ran against a
    // snapshot taken before the (slow) model call — in the meantime a user may have posted
    // this transaction, and re-pointing a POSTED entry's account behind their back is exactly
    // the kind of thing that makes books untrustworthy.
    const { data: entry } = await admin
      .from('journal_entries' as any)
      .select('status')
      .eq('book', ACTUAL_BOOK)
      .eq('id', t.journal_entry_id)
      .eq('fund_id', fundId)
      .maybeSingle()
    if ((entry as any)?.status !== 'draft') {
      errors.push(`${t.id}: skipped — its entry is no longer a draft`)
      continue
    }

    // Only re-point simple two-line drafts (exactly one non-cash posting).
    const { data: postings } = await admin
      .from('journal_postings' as any)
      .select('id, account_id')
      .eq('book', ACTUAL_BOOK)
      .eq('journal_entry_id', t.journal_entry_id)
    const nonCash = ((postings as any[]) ?? []).filter(p => p.account_id !== cashId)
    if (nonCash.length !== 1) continue

    await admin.from('journal_postings' as any).update({ account_id: newAccountId }).eq('id', nonCash[0].id)
    await admin.from('journal_entries' as any).update({ source_type: cat.sourceType }).eq('id', t.journal_entry_id).eq('fund_id', fundId)
    await admin.from('bank_transactions' as any).update({ suggested_account_code: cat.accountCode }).eq('id', t.id).eq('fund_id', fundId)
    updated++
  }

  return { considered: txns.length, updated, errors }
}
