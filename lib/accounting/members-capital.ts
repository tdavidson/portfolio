// Statement of changes in members' capital — the management-company counterpart of the
// statement of changes in partners' capital.
//
// A fund's partner roll-forward is built from per-LP capital sub-accounts (accounts carrying an
// lp_entity_id), each posting classified by its source type. A management company has none of
// that: its members' capital lives in ordinary equity accounts, its P&L closes through the
// undistributed-earnings bridge into a pooled members' capital account, and member draws land in
// a pooled distributions account until they are reclassed to the member. So the roll-forward is
// read from the journal itself: every equity movement is classified by the OTHER legs of its
// entry, and money that moves from a pooled account to a member takes the nature of that pool —
// earnings allocated from pooled capital are the member's share of net income, draws reclassed
// out of member distributions are the member's distributions.
//
// What is still pooled at a date (unallocated earnings, draws not yet reclassed, and any P&L not
// yet closed into equity) is one more row, so the totals column equals equity on the balance
// sheet.

import type { Account } from './types'
import type { SourcedPosting } from './load'
import { emptyAccount, type CapitalAccount } from './capital-account'
import type { ChangesInPartnersCapital, PartnerCapitalRow } from './statements'

function r(n: number): number {
  return Math.round(n * 100) / 100
}

const POOL = 'pool'

/** Pools whose movements to a member are draws or contributions rather than earnings. */
const CONTRIBUTION_POOLS = new Set(['member_distributions', 'member_contributions'])

type Nature = 'earnings' | 'cash' | 'none'

/** Strip the chart's "Members' capital — " prefix, so the row reads as the member's name. */
export function memberNameFromAccount(name: string): string {
  return name.replace(/^members?['’]?\s+capital\s*[—–-]\s*/i, '').trim() || name
}

/**
 * Each member's capital roll-forward for the period, plus the pooled remainder, in the same
 * shape as `changesInPartnersCapital` so the statements page, PDF and workbook render it as is.
 * A posting belongs to a member when it carries an lp_entity_id (on the posting or its account)
 * or sits in a `member_contributions` account; every other equity account except the bridge is
 * pooled.
 */
export function changesInMembersCapital(
  accounts: Account[],
  postings: SourcedPosting[],
  period: { start: string | null; end: string | null },
  names: Map<string, string> = new Map(),
): ChangesInPartnersCapital {
  const byId = new Map(accounts.map(a => [a.id, a]))
  const bridge = accounts.find(a => a.subtype === 'undistributed_earnings')
  const pooledRetained = accounts.some(a => a.type === 'equity' && a.subtype === 'retained_earnings')

  const holderOf = (p: SourcedPosting): string | null => {
    const a = byId.get(p.accountId)
    if (!a || a.type !== 'equity' || a.id === bridge?.id) return null
    return p.lpEntityId ?? a.lpEntityId ?? (a.subtype === 'member_contributions' ? a.id : POOL)
  }

  const memberNames = new Map<string, string>()
  const rows = new Map<string, CapitalAccount>()
  const row = (key: string) => {
    let acct = rows.get(key)
    if (!acct) { acct = emptyAccount(); rows.set(key, acct) }
    return acct
  }

  const inScope = postings.filter(p => !period.end || !p.entryDate || p.entryDate <= period.end)
  const entries = new Map<string, SourcedPosting[]>()
  for (const p of inScope) {
    const list = entries.get(p.entryId)
    if (list) list.push(p)
    else entries.set(p.entryId, [p])
  }

  // P&L not yet closed into equity (and the bridge that offsets what has been): equity on the
  // balance sheet less what the holders' accounts hold. Zero for a book that closes through the
  // bridge every posting; the period's net income for one that closes to retained earnings.
  let gapBefore = 0
  let gapDuring = 0

  for (const legs of entries.values()) {
    const date = legs[0].entryDate ?? null
    const before = !!(period.start && date && date < period.start)

    const deltas = new Map<string, number>()
    const poolSubtypes = new Set<string>()
    let nature: Nature = 'none'
    for (const p of legs) {
      const holder = holderOf(p)
      const a = byId.get(p.accountId)
      if (holder) {
        deltas.set(holder, (deltas.get(holder) ?? 0) - p.amount)
        if (holder === POOL && a?.subtype) poolSubtypes.add(a.subtype)
        if (holder !== POOL && !memberNames.has(holder) && a) memberNames.set(holder, memberNameFromAccount(a.name))
        continue
      }
      if (!a) continue
      if (a.type === 'income' || a.type === 'expense' || a.id === bridge?.id) {
        nature = 'earnings'
        if (before) gapBefore -= p.amount
        else gapDuring -= p.amount
      } else if (nature === 'none' && (a.type === 'asset' || a.type === 'liability')) {
        nature = 'cash'
      }
    }

    const put = (key: string, amount: number, field: keyof CapitalAccount) => {
      if (amount === 0) return
      row(key)[before ? 'beginning' : field] += amount
    }
    const byNature = (amount: number, n: Nature): keyof CapitalAccount =>
      n === 'earnings' ? 'operatingIncome'
        : n === 'cash' ? (amount > 0 ? 'contributions' : 'distributions')
          : 'transfers'

    const poolDelta = deltas.get(POOL) ?? 0
    deltas.delete(POOL)
    const memberTotal = Array.from(deltas.values()).reduce((s, v) => s + v, 0)
    const fromPool = poolSubtypes.size > 0 && memberTotal !== 0

    if (fromPool) {
      // Members draw on the pool: their movement takes the pool's nature, and the pool records
      // the same amount leaving it under the same heading, so the totals column counts it once.
      const contributionPool = Array.from(poolSubtypes).some(s => CONTRIBUTION_POOLS.has(s))
      const fieldFor = (amount: number): keyof CapitalAccount =>
        contributionPool ? (amount > 0 ? 'contributions' : 'distributions') : 'operatingIncome'
      for (const [key, amount] of deltas) put(key, amount, fieldFor(amount))
      for (const [key, amount] of deltas) put(POOL, -amount, fieldFor(amount))
      const rest = poolDelta + memberTotal
      put(POOL, rest, byNature(rest, nature))
    } else {
      for (const [key, amount] of deltas) put(key, amount, byNature(amount, nature))
      put(POOL, poolDelta, byNature(poolDelta, nature))
    }
  }

  if (gapBefore !== 0) row(POOL).beginning += gapBefore
  if (gapDuring !== 0) row(POOL).operatingIncome += gapDuring

  const finish = (acct: CapitalAccount): CapitalAccount => {
    const out = { ...acct }
    for (const f of Object.keys(out) as (keyof CapitalAccount)[]) out[f] = r(out[f])
    out.ending = r(
      (Object.keys(out) as (keyof CapitalAccount)[])
        .filter(f => f !== 'ending')
        .reduce((s, f) => s + out[f], 0),
    )
    return out
  }
  const isEmpty = (acct: CapitalAccount) => Object.values(acct).every(v => v === 0)

  const partners: PartnerCapitalRow[] = []
  for (const [key, acct] of rows) {
    if (key === POOL) continue
    const done = finish(acct)
    if (isEmpty(done)) continue
    partners.push({ id: key, name: names.get(key) ?? memberNames.get(key) ?? key, ...done })
  }
  partners.sort((a, b) => a.name.localeCompare(b.name))

  const pool = rows.get(POOL)
  if (pool) {
    const done = finish(pool)
    if (!isEmpty(done)) {
      partners.push({
        id: POOL,
        name: pooledRetained ? 'Retained earnings' : 'Not yet allocated to members',
        ...done,
      })
    }
  }

  const fields = Object.keys(emptyAccount()) as (keyof CapitalAccount)[]
  const totals = fields.reduce((acc, f) => {
    acc[f] = r(partners.reduce((s, p) => s + p[f], 0))
    return acc
  }, emptyAccount())
  return { partners, totals }
}
