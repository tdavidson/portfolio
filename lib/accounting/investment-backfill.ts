// Backfill: derive the entries historical tracker transactions never derived.
//
// Transactions recorded before derivation existed drafted nothing, so their vehicle's books are
// empty however much the tracker holds. This runs every one of them through the same
// draftEntryForTransaction a live save uses — so the backfill obeys the same rule: an entry with
// no cash leg (a mark) posts, one that moves cash (a purchase) drafts and waits for its bank match.
//
// IDEMPOTENT, keyed on source_ref = txnRef(txn.id). A transaction with a live (non-void) derived
// entry is left alone, so running it twice derives nothing twice; one whose entries were all
// voided is derived again, which is what a void is for.
//
// IT WILL NOT BOOK A POSITION TWICE. A company the ledger already carries through a non-derived
// entry — a cutover snapshot, a history replay, a QuickBooks import — is skipped and named. Its
// value is already on the books; deriving its transactions too would double it.
//
// IN DATE ORDER, because an exit's entry reads the carried values earlier entries put there.

import type { SupabaseClient } from '@supabase/supabase-js'
import { draftEntryForTransaction, txnRef } from './from-portfolio'
import { vehicleIdByName } from './vehicle-id'
import { readAll } from './bank-quickbooks-match'
import { ACTUAL_BOOK } from './books'

const TXN_REF_PREFIX = txnRef('')
const CHUNK = 200

export interface BackfillResult {
  /** Transactions with nothing derived yet — what a run would derive. */
  toDerive: number
  /** Already derived earlier (idempotency), left alone. */
  alreadyDerived: number
  /**
   * Derived earlier as DRAFTS by the old always-draft code, with no cash leg — marks recorded before
   * marks posted on record. They post now; otherwise that appreciation would stay off the books
   * while this card reported nothing to do.
   */
  toPost: number
  /** Companies the ledger carries through a non-derived entry, skipped so nothing books twice. */
  carriedElsewhere: string[]
  /** Entries posted on record (marks). */
  posted: number
  /** Entries drafted to wait for their bank match (purchases, exits, cash income). */
  awaitingBankMatch: number
  /** Set when the whole vehicle is refused, and why — nothing was derived. */
  blocked?: string
  /** Every transaction the ledger refused — a closed period, a missing account — by name. */
  refused: string[]
}

// Pooled (company-less) investment accounts: 1100 at cost, 1200 unrealized, 1250 FX translation.
// By subtype, not code — a management company's chart uses 1100 for receivables.
const POOLED_SUBTYPES = new Set(['investment', 'unrealized', 'fx_translation'])

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

/**
 * Rows that can never derive an entry, so are never "waiting for the ledger". Counting them kept
 * the card up forever, listing the same rows under "not booked" on every run. Mirrors the skips
 * at the top of draftEntryForTransaction; anything subtler is still derived and its reason reported.
 */
function impliesNoEntry(t: any): boolean {
  if (t.transaction_type === 'round_info' || t.transaction_type === 'split') return true
  if (t.transaction_type === 'unrealized_gain_change') return n(t.unrealized_value_change) === 0 && n(t.fx_value_change) === 0
  if (t.transaction_type === 'investment' && !t.converts_from_txn_id) return n(t.investment_cost) + n(t.fee_amount) === 0
  if (t.transaction_type === 'income') return n(t.income_amount) === 0
  return false
}

const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))

export async function backfillDerivedEntries(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const out: BackfillResult = { toDerive: 0, alreadyDerived: 0, toPost: 0, carriedElsewhere: [], posted: 0, awaitingBankMatch: 0, refused: [] }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return out

  const [txns, derived, companies, accounts] = await Promise.all([
    readAll<any>((from, to) => admin.from('investment_transactions' as any).select('*')
      .eq('fund_id', fundId).eq('portfolio_group', group).order('transaction_date').order('id').range(from, to)),
    readAll<any>((from, to) => admin.from('journal_entries' as any).select('id, status, source_ref, entry_date, journal_postings(account_id, amount)')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .neq('status', 'void').like('source_ref', `${TXN_REF_PREFIX}%`).order('id').range(from, to)),
    readAll<any>((from, to) => admin.from('companies' as any).select('id, name').eq('fund_id', fundId).order('id').range(from, to)),
    readAll<any>((from, to) => admin.from('chart_of_accounts' as any).select('id, code, company_id, subtype')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('id').range(from, to)),
  ])
  const names = new Map<string, string>(companies.map(c => [c.id, c.name]))
  const done = new Set(derived.map(e => e.source_ref))

  // Which companies does the ledger already carry through a POSTED entry derivation did not make?
  // Posted only: an unposted bank auto-draft or a manual draft is not on the books, and counting it
  // would leave a company off the ledger with no way back.
  const companyOfAccount = new Map<string, string>(
    accounts.filter(a => a.company_id).map(a => [a.id, a.company_id]))
  const foreignPosted = async (accountIds: string[]) => {
    const hits = new Set<string>()
    for (const ids of chunks(accountIds)) {
      const postings = await readAll<any>((from, to) => admin.from('journal_postings' as any)
        .select('account_id, journal_entry_id').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('account_id', ids).order('id').range(from, to))
      const foreign = new Set<string>()
      for (const eids of chunks([...new Set(postings.map(p => p.journal_entry_id))])) {
        const entries = await readAll<any>((from, to) => admin.from('journal_entries' as any).select('id, source_ref')
          .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('status', 'posted').in('id', eids).order('id').range(from, to))
        for (const e of entries) if (!String(e.source_ref ?? '').startsWith(TXN_REF_PREFIX)) foreign.add(e.id)
      }
      for (const p of postings) if (foreign.has(p.journal_entry_id)) hits.add(p.account_id)
    }
    return hits
  }

  // The POOLED investment accounts (1100/1200/1250 with no company) cannot be attributed to any
  // company. If an import or a hand entry put value there, every company might already be carried,
  // and deriving any of them could book it twice — so the whole vehicle waits for a person.
  const pooled = accounts.filter(a => !a.company_id && POOLED_SUBTYPES.has(a.subtype))
  const pooledHits = await foreignPosted(pooled.map(a => a.id))
  if (pooledHits.size > 0) {
    const codes = pooled.filter(a => pooledHits.has(a.id)).map(a => a.code).sort().join(', ')
    out.blocked = `The pooled investment account${pooledHits.size === 1 ? '' : 's'} ${codes} carr${pooledHits.size === 1 ? 'ies' : 'y'} posted entries that are not tied to any company, so backfilling could book a position twice. Move those postings to each company's own accounts first.`
    return out
  }

  const carried = new Set<string>()
  for (const accountId of await foreignPosted([...companyOfAccount.keys()])) carried.add(companyOfAccount.get(accountId)!)
  out.carriedElsewhere = [...carried].map(id => names.get(id) ?? id).sort()

  const pending = txns.filter(t => {
    if (impliesNoEntry(t)) return false
    if (done.has(txnRef(t.id))) { out.alreadyDerived++; return false }
    return !carried.has(t.company_id)
  })
  out.toDerive = pending.length

  out.toPost = 0
  if (opts.dryRun) return out

  for (const t of pending) {
    const name = names.get(t.company_id) ?? 'Investment'
    const r = await draftEntryForTransaction(admin, fundId, userId, t, name)
    if (r.drafted) r.posted ? out.posted++ : out.awaitingBankMatch++
    else if (r.reason) out.refused.push(`${name}, ${t.transaction_date}: ${r.reason}`)
  }
  return out
}
