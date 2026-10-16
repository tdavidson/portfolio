// Acting on one staged bank transaction: re-point its draft to an account, or post it.
// Shared by the bank page (app/api/accounting/bank, actions 'setAccount' and 'post') and the
// agent's set_bank_transaction_account / post_bank_transaction tools, so both go through one path
// with the same guards.

import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAudit } from '@/lib/audit/events'
import { vehicleIdByName } from './vehicle-id'
import { accountIdByCode } from './persist'
import { ESCROW_VIA_HOLDING, counterPosting } from './bank'
import { ESCROW_CODE } from './adopt'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import { ACTUAL_BOOK } from './books'
import { postExistingEntryWithAllocation, setGeneratedAllocationStatus } from './continuous-allocation'
import { underReview } from './bank-review'
import { entryCarriesInvestments, BANK_ROW_IS_AN_INVESTMENT } from './ownership'
import { NEEDS_INVESTMENTS_WRITE } from './investment-access'
import { categorizationRecord, sourceTypeForAccount } from './bank-categorize'

export type BankActionError = { error: string; status: number }

/**
 * The entry-state guard the bank routes used to be missing.
 *
 * `unpost` and `restore` checked the closed period; `post`, `postMany` and `ignore` did
 * not, and none of them checked the entry's STATUS. So bank-posting a draft dated inside a
 * closed month injected P&L into locked books, and posting a transaction whose entry had
 * been voided (by `ignore`) resurrected that entry straight to `posted` — a transition the
 * journal route explicitly forbids.
 *
 * Returns an error string, or null when the transition is allowed.
 */
export async function guardBankEntries(
  admin: SupabaseClient, fundId: string, group: string,
  entryIds: string[], allowed: ('draft' | 'posted')[],
): Promise<string | null> {
  if (entryIds.length === 0) return null
  const { data: entries } = await admin
    .from('journal_entries' as any)
    .select('id, status, entry_date')
    .eq('book', ACTUAL_BOOK)
    .eq('fund_id', fundId)
    .in('id', entryIds)

  const closed = await closedPeriodRanges(admin, fundId, group)
  for (const e of ((entries as any[]) ?? [])) {
    if (!allowed.includes(e.status)) {
      return e.status === 'void'
        ? 'That entry was voided. Restore the transaction to draft it again.'
        : `That entry is already ${e.status}.`
    }
    if (e.entry_date && dateInAnyClosedPeriod(closed, e.entry_date)) {
      return `That entry is dated ${e.entry_date}, inside a closed period — reopen it first.`
    }
  }
  return null
}

/**
 * An escrow release clears the receivable the exit recognized — and the escrow receipt
 * recorded on the holding posts exactly that (lib/accounting/from-portfolio.ts). A bank entry
 * crediting 1350 as well would clear it twice, so the bank row is LINKED to the receipt's
 * entry instead ("Investments with no bank transaction"), never posted to 1350 itself.
 */
export async function bankEscrowPostings(
  admin: SupabaseClient, fundId: string, group: string, entryIds: string[],
): Promise<string | null> {
  if (entryIds.length === 0) return null
  const codes = await accountIdByCode(admin, fundId, group)
  const escrowId = codes.get(ESCROW_CODE)
  if (!escrowId) return null
  const { data, error } = await admin.from('journal_postings' as any).select('journal_entry_id')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('journal_entry_id', entryIds).eq('account_id', escrowId).limit(1)
  if (error) return `The entry could not be checked: ${error.message}`
  return ((data as any[]) ?? []).length > 0 ? ESCROW_VIA_HOLDING : null
}

/** The staged row, scoped to this fund and vehicle, refusing one linked to an existing entry. */
async function loadActionableTxn(
  admin: SupabaseClient, fundId: string, group: string, id: string,
): Promise<{ txn: any; entryId: string | null; vehicleId: string | null } | BankActionError> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data: txn } = await admin
    .from('bank_transactions' as any)
    .select('id, journal_entry_id, status, amount, raw')
    .eq('id', id)
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (!txn) return { error: 'Transaction not found', status: 404 }
  const entryId = (txn as any).journal_entry_id ?? null
  if (entryId && underReview((txn as any).raw)) {
    return { error: 'This bank row is linked to an existing journal entry. Manage that entry from the Journal.', status: 400 }
  }
  return { txn, entryId, vehicleId }
}

/**
 * Override the suggested account before posting: re-point the draft entry's single non-cash
 * posting to the chosen chart account.
 */
export async function setBankTransactionAccount(
  admin: SupabaseClient, fundId: string, group: string, id: string, accountCode: unknown,
  /** Who is choosing: a person on the bank page, or an agent. Only a person's choice is learned from as a draft. */
  chosenBy: 'user' | 'ai' = 'user',
  /**
   * A draft split across several accounts (a distribution spread pro rata over every partner,
   * say) has no single posting to re-point. With this, the split is replaced by one posting to
   * the chosen account. Drafts only: a posted entry is never rewritten here.
   */
  opts: { replaceSplit?: boolean } = {},
): Promise<{ ok: true; suggested_account_code: string; replacedSplit?: number } | BankActionError> {
  const loaded = await loadActionableTxn(admin, fundId, group, id)
  if ('error' in loaded) return loaded
  const { txn, entryId, vehicleId } = loaded

  // An entry investment transactions own is not this page's to re-point: there, acting on the
  // entry is deleting the transaction. Fails closed — a read that cannot tell is a refusal.
  if (entryId) {
    try {
      const { data: e, error: eErr } = await admin.from('journal_entries' as any).select('id, status, reversed_by, source_ref')
        .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', entryId).maybeSingle()
      if (eErr) throw new Error(eErr.message)
      if (e && vehicleId && await entryCarriesInvestments(admin, fundId, vehicleId, e as any)) {
        return { error: BANK_ROW_IS_AN_INVESTMENT, status: 400 }
      }
    } catch (e) {
      console.error('[bank-entry-ownership]', e instanceof Error ? e.message : e)
      return { error: 'Could not check whether this row is an investment payment, so nothing was changed. Try again.', status: 500 }
    }
  }

  if (txn.status !== 'drafted') return { error: 'Only a drafted transaction can be re-categorized', status: 400 }
  const code = String(accountCode ?? '').trim()
  if (!code) return { error: 'accountCode is required', status: 400 }
  if (code === ESCROW_CODE) return { error: ESCROW_VIA_HOLDING, status: 400 }
  const codes = await accountIdByCode(admin, fundId, group)
  const newAccountId = codes.get(code)
  if (!newAccountId) return { error: 'Unknown account for this vehicle', status: 400 }
  if (!entryId) return { error: 'No draft entry to update', status: 400 }

  // The account CARRIES the partner: a per-LP capital account has its own lp_entity_id, and
  // the capital roll-forward only counts a posting when the posting AND the account both
  // have one (load.ts:107-126). Re-pointing account_id alone put the money on the partner's
  // account with a null tag — visible in the trial balance, invisible in that partner's
  // capital account, statement and the LP portal. Carry the tag across, and clear it when
  // moving to a general account so a stale partner can't linger on a re-categorized row.
  const { data: acct } = await admin
    .from('chart_of_accounts' as any)
    .select('lp_entity_id, code, type, subtype')
    .eq('id', newAccountId)
    .maybeSingle()
  const newLpEntityId = (acct as any)?.lp_entity_id ?? null

  const cashId = codes.get('1000')
  const { data: postings } = await admin
    .from('journal_postings' as any)
    .select('id, account_id, amount')
    .eq('book', ACTUAL_BOOK)
    .eq('journal_entry_id', entryId)
  const counter = counterPosting((postings as any[]) ?? [], cashId, Number(txn.amount))
  let replacedSplit: number | undefined
  if (counter) {
    await admin.from('journal_postings' as any)
      .update({ account_id: newAccountId, lp_entity_id: newLpEntityId })
      .eq('id', counter.id)
  } else if (!opts.replaceSplit) {
    return { error: 'This entry has a custom allocation — edit it in the Journal, or pass replaceSplit to replace it with one posting.', status: 400 }
  } else {
    const replaced = await replaceSplitWithOne(admin, fundId, group, vehicleId, entryId, (postings as any[]) ?? [], cashId, newAccountId, newLpEntityId)
    if ('error' in replaced) return replaced
    replacedSplit = replaced.replaced
  }
  // The entry's source type was set from the first suggestion. Left alone, an interest receipt
  // first suggested as LP capital posted as a capital call, and statements that classify by
  // source counted it there. It follows the account now.
  if (acct) {
    await admin.from('journal_entries' as any)
      .update({ source_type: sourceTypeForAccount(acct as any, Number(txn.amount) > 0) })
      .eq('id', entryId).eq('fund_id', fundId)
  }
  // Recorded as a choice: the AI pass leaves a person's alone, and the next import learns from it.
  const categorization = categorizationRecord(chosenBy === 'user'
    ? { by: 'user', confidence: 'high', reason: 'Chosen by hand' }
    : { by: 'ai', confidence: 'high', reason: 'Re-pointed by an agent' })
  await admin.from('bank_transactions' as any)
    .update({ suggested_account_code: code, raw: { ...(txn.raw ?? {}), categorization } })
    .eq('id', id).eq('fund_id', fundId)
  return { ok: true, suggested_account_code: code, ...(replacedSplit !== undefined ? { replacedSplit } : {}) }
}

/**
 * Replace a draft's non-cash postings with one posting to `accountId` for the whole amount.
 * The new set (the cash lines again, plus the one counter line) is inserted before the old set is
 * deleted: each set balances on its own, so the entry balances after every statement and the
 * deferred balance trigger (20260714000004_ledger_db_enforcement.sql) never sees it out.
 */
async function replaceSplitWithOne(
  admin: SupabaseClient, fundId: string, group: string, vehicleId: string | null, entryId: string,
  postings: { id: string; account_id: string; amount: number | string }[], cashId: string | undefined,
  accountId: string, lpEntityId: string | null,
): Promise<{ replaced: number } | BankActionError> {
  const { data: entry } = await admin.from('journal_entries' as any).select('status')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', entryId).maybeSingle()
  if ((entry as any)?.status !== 'draft') return { error: 'Only a draft entry can have its split replaced.', status: 400 }
  const cash = postings.filter(p => p.account_id === cashId)
  if (cash.length === 0) return { error: 'This entry has no cash line to keep, so its split cannot be replaced here. Edit it in the Journal.', status: 400 }
  const cashTotal = Math.round(cash.reduce((sum, p) => sum + Number(p.amount), 0) * 100) / 100
  const row = (account: string, amount: number, lp: string | null) => ({
    fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId, journal_entry_id: entryId,
    account_id: account, amount, currency: 'USD', lp_entity_id: lp,
  })
  const { error: insErr } = await admin.from('journal_postings' as any).insert([
    ...cash.map(p => row(p.account_id, Number(p.amount), null)),
    row(accountId, -cashTotal, lpEntityId),
  ])
  if (insErr) return { error: `The split could not be replaced: ${insErr.message}`, status: 400 }
  const { error: delErr } = await admin.from('journal_postings' as any).delete().in('id', postings.map(p => p.id))
  if (delErr) return { error: `The new posting was added but the old split could not be removed: ${delErr.message}. Edit the entry in the Journal.`, status: 500 }
  return { replaced: postings.length - cash.length }
}

/**
 * Set aside a bank row that is not the vehicle's cash movement (a money-market sweep, a
 * duplicate): the bank page's Ignore, for rows that are not posted. Its draft entry is voided.
 * A posted row is refused: voiding what is on the books needs a reason and stays on the bank
 * page. A row whose entry belongs to an investment transaction is only unlinked, as on the page.
 */
export async function ignoreBankTransaction(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, id: string,
): Promise<{ ok: true; status: 'ignored'; note?: string } | BankActionError> {
  const loaded = await loadActionableTxn(admin, fundId, group, id)
  if ('error' in loaded) return loaded
  const { txn, entryId, vehicleId } = loaded
  if (txn.status === 'ignored') return { error: 'That transaction is already ignored.', status: 400 }
  if (txn.status === 'reconciled') return { error: 'That transaction is posted. Ignoring it voids a posted entry, which needs a reason: do it on the bank page.', status: 400 }

  if (entryId) {
    let investment = false
    try {
      const { data: e, error: eErr } = await admin.from('journal_entries' as any).select('id, status, reversed_by, source_ref')
        .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', entryId).maybeSingle()
      if (eErr) throw new Error(eErr.message)
      investment = !!e && !!vehicleId && await entryCarriesInvestments(admin, fundId, vehicleId, e as any)
    } catch (e) {
      console.error('[bank-entry-ownership]', e instanceof Error ? e.message : e)
      return { error: 'Could not check whether this row is an investment payment, so nothing was changed. Try again.', status: 500 }
    }
    if (investment) {
      await admin.from('bank_transactions' as any).update({ status: 'ignored', journal_entry_id: null }).eq('id', id).eq('fund_id', fundId)
      return { ok: true, status: 'ignored', note: 'The bank row was set aside. Its journal entry belongs to an investment transaction and was left as it is.' }
    }
    const problem = await guardBankEntries(admin, fundId, group, [entryId], ['draft'])
    if (problem) return { error: problem, status: 400 }
    const linked = await setGeneratedAllocationStatus(admin, fundId, entryId, 'void')
    if (linked.error) return { error: linked.error, status: 400 }
    const { error } = await admin.from('journal_entries' as any).update({ status: 'void', posted_at: null }).eq('id', entryId).eq('fund_id', fundId)
    if (error) return { error: `The draft entry could not be voided: ${error.message}`, status: 500 }
    await recordAudit(admin, { fundId, vehicleId, actorId: userId, action: 'entry.void', subjectType: 'journal_entry', subjectId: entryId, details: { bankTransactionId: id, priorStatus: 'draft' } })
  }
  await admin.from('bank_transactions' as any).update({ status: 'ignored' }).eq('id', id).eq('fund_id', fundId)
  return { ok: true, status: 'ignored' }
}

/** Post one drafted transaction's entry and mark the row reconciled. */
export async function postBankTransaction(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, id: string,
  opts: { investments: boolean },
): Promise<Record<string, unknown> | BankActionError> {
  const loaded = await loadActionableTxn(admin, fundId, group, id)
  if ('error' in loaded) return loaded
  const { txn, entryId, vehicleId } = loaded

  if (txn.status !== 'drafted') return { error: 'Only a drafted transaction can be posted.', status: 400 }
  if (entryId) {
    const problem = await guardBankEntries(admin, fundId, group, [entryId], ['draft']) ?? await bankEscrowPostings(admin, fundId, group, [entryId])
    if (problem) return { error: problem, status: 400 }

    const result = await postExistingEntryWithAllocation(admin, fundId, group, userId, entryId, { investments: opts.investments })
    if ('error' in result) return { error: result.error, status: result.error === NEEDS_INVESTMENTS_WRITE ? 403 : 400 }
    await admin.from('bank_transactions' as any).update({ status: 'reconciled' }).eq('id', id).eq('fund_id', fundId)
    await recordAudit(admin, { fundId, vehicleId, actorId: userId, action: 'entry.post', subjectType: 'journal_entry', subjectId: entryId, details: { bankTransactionId: id } })
    return {
      ok: true, status: 'reconciled',
      removedTransactions: result.removedTransactions ?? [], unlinkedRegisterRows: result.unlinkedRegisterRows ?? [],
      ...(result.warning ? { warning: result.warning } : {}),
    }
  }
  await admin.from('bank_transactions' as any).update({ status: 'reconciled' }).eq('id', id).eq('fund_id', fundId)
  return { ok: true, status: 'reconciled' }
}
