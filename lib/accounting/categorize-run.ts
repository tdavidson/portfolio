// Run AI categorization over staged bank transactions and apply the results by
// re-pointing each draft entry's non-cash posting. Shared by the REST route and
// the agent tool. Only touches simple two-line bank drafts — an entry that's
// been turned into an allocated capital call (many postings) is left alone.

import { fundHasAIKey, noKeyMessage } from '@/lib/ai/keyless'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFundAIProviderWithOverride } from '@/lib/ai'
import { loadPostedLedger } from './load'
import { RECEIVABLE_CODE, DISTRIBUTION_PAYABLE_CODE } from './chart'
import { accountIdByCode } from './persist'
import { vehicleIdByName } from './vehicle-id'
import { buildCategorizePrompt, parseCategorizations, type Categorization, type TxnToCategorize } from './categorize-ai'
import { categorizationRecord, sourceTypeFollowingAccount } from './bank-categorize'
import { categorizedBy } from './bank-categorize-context'
import { ENTRY_SOURCE_TYPES } from './source-types'
import { ACTUAL_BOOK } from './books'
import { counterPosting } from './bank'

/** Rows per model request: small enough that the JSON answer always fits in the output cap. */
export const CATEGORIZE_BATCH_SIZE = 40

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

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
    .select('id, journal_entry_id, txn_date, amount, description, counterparty, raw')
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
  // A person's choice is never second-guessed. An account learned from this entity's own history
  // is kept too, unless someone asked for these rows by name: that answer came from a person
  // once already, and the model has never seen it.
  const txns = ((rows as any[]) ?? []).filter(t => {
    const by = categorizedBy(t.raw)
    return by !== 'user' && !(by === 'history' && !(ids && ids.length))
  })
  if (txns.length === 0) return { considered: 0, updated: 0, errors: [] }

  const { accounts } = await loadPostedLedger(admin, fundId, group)
  if (accounts.length === 0) return { error: "This entity has no chart of accounts yet. Import its bank transactions, or open its Admin → Chart of accounts." }
  const codes = await accountIdByCode(admin, fundId, group)
  const cashId = codes.get('1000')

  const toCategorize: TxnToCategorize[] = txns.map(t => ({
    id: t.id, date: t.txn_date, amount: Number(t.amount), description: t.description ?? '',
    counterparty: t.counterparty ?? null, activity: t.raw?.activity ?? null,
  }))

  if (!(await fundHasAIKey(admin, fundId))) return { error: noKeyMessage('bank_categorize', 'categorise transactions') }
  let provider
  try {
    provider = await createFundAIProviderWithOverride(admin, fundId)
  } catch (e) {
    return { error: `AI provider not configured: ${(e as Error).message}` }
  }

  // In batches. One request for the whole feed ran out of output on any real import (a couple of
  // hundred rows is well past the token cap), the JSON came back cut off, and the entire run
  // failed. A batch that fails now costs only its own rows.
  const errors: string[] = []
  const parsed: Categorization[] = []
  const batches = chunk(toCategorize, CATEGORIZE_BATCH_SIZE)
  let failedBatches = 0
  for (const batch of batches) {
    const { system, content } = buildCategorizePrompt(accounts, batch)
    try {
      const result = await provider.provider.createMessage({ model: provider.model, maxTokens: 4000, system, content })
      parsed.push(...parseCategorizations(result.text))
    } catch (e) {
      failedBatches++
      errors.push(`AI categorization failed for ${batch.length} transaction${batch.length === 1 ? '' : 's'}: ${(e as Error).message}`)
    }
  }
  if (failedBatches === batches.length) return { error: errors[0] ?? 'AI categorization failed' }

  const byId = new Map(parsed.map(c => [c.id, c]))
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

    // Only re-point simple two-line drafts (see counterPosting).
    const { data: postings } = await admin
      .from('journal_postings' as any)
      .select('id, account_id, amount')
      .eq('book', ACTUAL_BOOK)
      .eq('journal_entry_id', t.journal_entry_id)
    const counter = counterPosting((postings as any[]) ?? [], cashId, Number(t.amount))
    if (!counter) continue

    // The model's source type stands unless it contradicts the account it picked (a capital call
    // on an interest account, say): the account is what the books carry, so the type follows it.
    const acct = accounts.find(a => a.code === cat.accountCode)
    const sourceType = acct ? sourceTypeFollowingAccount(cat.sourceType, acct, Number(t.amount) > 0) : cat.sourceType
    await admin.from('journal_postings' as any).update({ account_id: newAccountId }).eq('id', counter.id)
    await admin.from('journal_entries' as any).update({ source_type: sourceType }).eq('id', t.journal_entry_id).eq('fund_id', fundId)
    await admin.from('bank_transactions' as any)
      .update({ suggested_account_code: cat.accountCode, raw: { ...(t.raw ?? {}), categorization: categorizationRecord({ by: 'ai', confidence: 'high', reason: 'Suggested by the AI pass' }) } })
      .eq('id', t.id).eq('fund_id', fundId)
    updated++
  }

  return { considered: txns.length, updated, errors }
}
