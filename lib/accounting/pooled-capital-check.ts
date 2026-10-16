// Detect LP capital stranded on the pooled "Partners' capital — LP (unallocated)" account.
//
// The capital-account roll-forward attributes a posting to a partner only when the posting
// AND the account it lands on both carry an lp_entity_id (load.ts:107-126). A vehicle
// onboarded before its per-LP capital accounts existed books everything to the pooled 3100
// instead, so every capital posting is silently discarded: Called, Beginning and Ending all
// read 0 while Committed — which never touches the ledger — reads correctly.
//
// That state is indistinguishable from "this vehicle has no capital yet" unless something
// goes looking. Worse, the balance sheet can still tie: the offsetting error sits in a
// receivable, so assets and equity are inflated by the same amount and `check` reads 0.
// Nothing about a balanced trial balance rules this out. This is the something that looks.

import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from './vehicle-id'
import { fetchAllRows } from './load'
import { roundCents } from './ledger'
import { ACTUAL_BOOK } from './books'

export interface StrandedCapital {
  /** Postings sitting on a pooled LP capital account. */
  pooledPostings: number
  /** Their net amount, in the ledger's debit-positive convention. */
  pooledAmount: number
  /** Of those, the ones carrying an lp_entity_id — re-pointable automatically. */
  taggedPostings: number
  /** Per-LP capital accounts that exist on this vehicle today. */
  perLpAccounts: number
  /** Capital is reaching nobody. */
  stranded: boolean
  /** Operator-facing explanation, or null when nothing is wrong. */
  message: string | null
}

const money = (n: number) =>
  Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/**
 * The judgement, split out from the queries so it can be pinned by a test.
 *
 * ANY posting left on the pooled account counts as stranded, not just the case of zero
 * per-LP accounts. A half-attributed vehicle is worse than an un-attributed one: some
 * partners' figures look right, which makes the wrong ones look like real zeroes.
 *
 * The exception is postings that net to zero. A receipt booked to the pool and then
 * reclassed out to the partner's own account, or a reversed entry, leaves history on the
 * pooled account but no capital stranded there: every partner's ending balance is whole.
 */
export function describeStrandedCapital(input: {
  pooledPostings: number
  pooledAmount: number
  taggedPostings: number
  perLpAccounts: number
}): StrandedCapital {
  const { pooledPostings, pooledAmount, taggedPostings, perLpAccounts } = input
  if (pooledPostings === 0 || Math.abs(roundCents(pooledAmount)) < 0.005) {
    return { ...input, stranded: false, message: null }
  }
  const untagged = pooledPostings - taggedPostings
  const scope = perLpAccounts === 0
    ? 'No partner has a capital account on this vehicle yet, so every partner reads 0.'
    : `${perLpAccounts} partner capital account${perLpAccounts === 1 ? '' : 's'} exist, so only some partners are affected — which makes the rest look like real zeroes.`
  return {
    ...input,
    stranded: true,
    message:
      `${pooledPostings} posting${pooledPostings === 1 ? '' : 's'} totalling ${money(pooledAmount)} sit on the pooled ` +
      `"Partners' capital — LP (unallocated)" account and reach no partner's capital account. ` +
      `${scope} Called, Funded, Beginning and Ending are wrong until this is attributed. ` +
      (untagged > 0
        ? `${taggedPostings} can be attributed automatically; ${untagged} carry no LP and need splitting by hand.`
        : `All ${taggedPostings} can be attributed automatically.`),
  }
}

/** Look up the vehicle's stranded-capital state. Reads only. */
export async function loadStrandedCapital(
  admin: SupabaseClient,
  fundId: string,
  group: string,
): Promise<StrandedCapital> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data: accounts } = await (admin as any)
    .from('chart_of_accounts')
    .select('id, subtype, lp_entity_id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  const rows = ((accounts as any[]) ?? [])
  const pooledIds = rows.filter(a => a.subtype === 'lp_capital' && !a.lp_entity_id).map(a => a.id as string)
  const perLpAccounts = rows.filter(a => a.lp_entity_id).length

  if (pooledIds.length === 0) {
    return describeStrandedCapital({ pooledPostings: 0, pooledAmount: 0, taggedPostings: 0, perLpAccounts })
  }

  // Paginate — PostgREST caps a response at 1000 rows, and a full-history vehicle can hold
  // more pooled postings than that. An unpaginated read would under-report the problem.
  const posts = await fetchAllRows<any>((f, t) =>
    (admin as any)
      .from('journal_postings')
      .select('id, amount, lp_entity_id, journal_entries!inner(status)')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', fundId)
      .in('account_id', pooledIds)
      .range(f, t),
  )
  const live = (posts ?? []).filter(p => p.journal_entries?.status === 'posted')

  return describeStrandedCapital({
    pooledPostings: live.length,
    pooledAmount: roundCents(live.reduce((s, p) => s + Number(p.amount), 0)),
    taggedPostings: live.filter(p => p.lp_entity_id).length,
    perLpAccounts,
  })
}
