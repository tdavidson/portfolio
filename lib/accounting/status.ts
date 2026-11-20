// Entity book health, data completeness, and reconciliation work. No activation state.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPostedLedger, loadOwnership } from './load'
import { loadStrandedCapital, type StrandedCapital } from './pooled-capital-check'
import { balanceSheet, scheduleOfInvestments, postingsAsOf, soiTies } from './statements'
import { buildSoiPositions, type SoiCompany } from './soi'
import { computeCapitalAccounts, totalNav } from './capital-account'
import { loadAllocationBasis, type AllocationBasis } from './terms'
import { loadPositions } from './lp-positions'
import { resolveCapitalEvidence } from './capital-evidence'
import { nextCloseStart } from './close'
import { vehicleIdByName } from './vehicle-id'
import { vehicleKindByName } from './vehicle-domain'
import { closesToOwnerEquity, isManagementCompany } from '@/lib/vehicle-kinds'
import { equityLabel } from './vocab'
import { roundCents } from './ledger'
import { ACTUAL_BOOK } from './books'
import { chartForVehicleKind } from './chart'
import { intercompanyBalances } from './intercompany'
import { backfillDerivedEntries } from './investment-backfill'
import { loadEscrowExits, needsReview } from './escrow-exit-review'

export type IssueLevel = 'blocker' | 'warning' | 'info'

export interface StatusIssue {
  level: IssueLevel
  title: string
  detail: string
  /** Where to go to fix it. */
  href?: string
  action?: string
}

export interface VehicleStatus {
  vehicle: string
  setup: {
    chartSeeded: boolean
    accountCount: number
    hasPostedEntries: boolean
    partnerCount: number
    partnersWithCommitment: number
    /** Every LP capital posting has reached a partner's OWN capital account. */
    capitalAttributed: boolean
    stranded: StrandedCapital
  }
  investments: {
    trackerPositions: number
    trackerCost: number
    trackerFairValue: number
    ledgerCost: number
    ledgerFairValue: number
    /** Positions whose own accounts disagree with the tracker. */
    offLedger: number
  }
  ledger: {
    entryCount: number
    draftCount: number
    postedCount: number
    trialBalanced: boolean
    nav: number
    netAssets: number
    capitalTies: boolean
    capitalGap: number
  }
  close: {
    basis: AllocationBasis
    lastClosedEnd: string | null
    lastClosedLabel: string | null
    /** Where the next close would begin. Null = nothing to close. */
    nextStart: string | null
    unallocatedEarnings: number
  }
  bank: {
    total: number
    needsAttention: number
  }
  issues: StatusIssue[]
}

export async function vehicleStatus(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<VehicleStatus> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const kind = await vehicleKindByName(admin, fundId, group)
  const manco = isManagementCompany(kind)
  const ownerEquity = closesToOwnerEquity(kind)

  const [
    { accounts, postings, capitalPostings, sourcedPostings },
    owners,
    basis,
    { data: entryRows },
    { data: bankRows },
    { data: periodRows },
    { data: txns },
    { data: companies },
    balances,
  ] = await Promise.all([
    loadPostedLedger(admin, fundId, group),
    manco ? Promise.resolve([]) : loadOwnership(admin, fundId, group),
    manco ? Promise.resolve('capital_balance' as const) : loadAllocationBasis(admin, fundId, group),
    admin.from('journal_entries' as any).select('id, status').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).neq('status', 'void'),
    admin.from('bank_transactions' as any).select('id, status').eq('fund_id', fundId).eq('vehicle_id', vehicleId),
    admin.from('fiscal_periods' as any).select('period_end, label').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'closed').order('period_end', { ascending: false }).limit(1),
    manco ? Promise.resolve({ data: [] }) : admin.from('investment_transactions' as any).select('*').eq('fund_id', fundId),
    manco ? Promise.resolve({ data: [] }) : admin.from('companies' as any).select('*').eq('fund_id', fundId),
    manco ? intercompanyBalances(admin, fundId, group) : Promise.resolve([]),
  ])

  const entries = ((entryRows as any[]) ?? [])
  const bank = ((bankRows as any[]) ?? [])
  const draftCount = entries.filter(e => e.status === 'draft').length
  const postedCount = entries.filter(e => e.status === 'posted').length
  const bankNeedsAttention = bank.filter(t => t.status === 'unmatched' || t.status === 'drafted').length

  const bs = balanceSheet(accounts, postingsAsOf(postings, null), { equityLabel: equityLabel(kind), itemizeEquity: ownerEquity })
  const capitalAccounts = computeCapitalAccounts(capitalPostings)
  const nav = totalNav(capitalAccounts)

  const positions = buildSoiPositions((txns as any[]) ?? [], ((companies as any[]) ?? []) as SoiCompany[], group)
  const soi = scheduleOfInvestments(accounts, postings, nav, positions, ((companies as any[]) ?? []) as SoiCompany[])

  const lastClosed = ((periodRows as any[]) ?? [])[0] ?? null
  const nextStart = await nextCloseStart(admin, fundId, group)

  const partnersWithCommitment = owners.filter(o => o.commitment > 0).length

  const accountCodes = new Set(accounts.map(a => a.code))
  const chartSeeded = manco
    ? chartForVehicleKind(kind).every(a => accountCodes.has(a.code))
    : accounts.length > 0
  const hasPostedEntries = postedCount > 0

  // Capital sitting on the POOLED account reaches no partner, so
  // every per-LP figure reads 0 while the vehicle looks finished. Counting it as finished is
  // what let the setup tools — including the attribution repair — disappear from Status on a
  // vehicle that still needed them, leaving no route to the fix from anywhere in the product.
  const stranded: StrandedCapital = manco
    ? { pooledPostings: 0, pooledAmount: 0, taggedPostings: 0, perLpAccounts: 0, stranded: false, message: null }
    : await loadStrandedCapital(admin, fundId, group)
  const capitalAttributed = !stranded.stranded

  // ---------------------------------------------------------------------------
  // What needs attention, worst first.
  // ---------------------------------------------------------------------------
  const issues: StatusIssue[] = []
  if (!manco) {
    const observations = await loadPositions(admin, fundId, group)
    const resolved = resolveCapitalEvidence(capitalPostings, observations, undefined, ((periodRows as any[]) ?? [])[0]?.period_end)
    const evidence = Array.from(resolved.evidenceByLp.values())
    const entries = Array.from(resolved.evidenceByLp.entries())
    const conflicted = entries.filter(([, e]) => e.conflict)
    const incomplete = evidence.filter(e => e.missing.length > 0).length
    const reported = entries.filter(([, e]) => e.basis === 'reported')
    const names = conflicted.length + reported.length > 0
      ? await partnerNames(admin, fundId, [...conflicted, ...reported].map(([id]) => id))
      : new Map<string, string>()
    // The imported balances live on the LP capital page, by date, where they can be compared with
    // the books and deleted. The entity's capital-accounts page shows neither, so link there.
    const importsHref = (date: string | undefined) =>
      `/lps/capital?vehicle=${encodeURIComponent(group)}${date ? `&asOf=${date}` : ''}#history`
    if (conflicted.length) {
      const importDates = Array.from(new Set(conflicted.map(([, e]) => e.anchor?.date).filter((d): d is string => !!d))).sort()
      const date = importDates.at(-1)
      const when = importDates.length > 1 ? `${importDates[0]} through ${date}` : date ?? 'their import date'
      const lines = conflicted.slice(0, 3).map(([id, e]) => {
        const nav = e.anchor?.variance?.nav
        return `${names.get(id) ?? 'A partner'}${nav ? ` (books ${nav > 0 ? 'higher' : 'lower'} by ${money(nav)})` : ''}`
      })
      issues.push({
        level: 'warning',
        title: `${conflicted.length} partner${conflicted.length === 1 ? '' : 's'} differ${conflicted.length === 1 ? 's' : ''} from the balances imported for ${when}`,
        detail: `${lines.join(', ')}${conflicted.length > 3 ? `, and ${conflicted.length - 3} more` : ''}. `
          + 'Statements and reports use the books, so nothing they show comes from the import. '
          + 'If the books are right (they were rebuilt or reconciled after the import), delete that import to clear this. '
          + 'If the import is right, correct the books.',
        href: importsHref(date),
        action: 'Compare with the import',
      })
    }
    if (incomplete) issues.push({ level: 'warning', title: `${incomplete} incomplete capital position${incomplete === 1 ? '' : 's'}`, detail: 'Missing amounts appear as a dash, including totals that depend on them. Enter the missing contributions, distributions, or NAV.', href: '/funds/capital-accounts', action: 'Review balances' })
    if (reported.length) {
      const dates = reported.map(([, e]) => e.asOf!).sort()
      const when = `${dates[0]}${dates.at(-1) !== dates[0] ? ` through ${dates.at(-1)}` : ''}`
      const who = reported.slice(0, 3).map(([id]) => names.get(id) ?? 'A partner').join(', ')
      issues.push({
        level: 'info',
        title: `${reported.length} partner${reported.length === 1 ? ' reports' : 's report'} imported balances, not the books`,
        detail: `${who}${reported.length > 3 ? `, and ${reported.length - 3} more` : ''}: no capital activity for ${reported.length === 1 ? 'this partner' : 'these partners'} is on the books, `
          + `so ${reported.length === 1 ? 'their figures come' : 'their figures come'} from the balances imported for ${when} and stay at that date. `
          + 'Book their contributions and distributions to report them from the books instead.',
        href: importsHref(dates.at(-1)),
        action: 'View the import',
      })
    }
  }

  if (!bs.check || Math.abs(bs.check) > 0.004) {
    if (Math.abs(bs.check) > 0.004) {
      issues.push({ level: 'blocker', title: 'Balance sheet does not balance', detail: `Assets less liabilities and ${equityLabel(kind).toLowerCase()} leaves ${bs.check.toFixed(2)}. Something is booked wrong.`, href: '/funds/statements', action: 'Open the statements' })
    }
  }

  if (bankNeedsAttention > 0) {
    issues.push({
      level: 'blocker',
      title: `${bankNeedsAttention} bank transaction${bankNeedsAttention === 1 ? '' : 's'} not posted`,
      detail: 'These transactions are not fully recorded in the books. Review and post them before closing their period.',
      href: '/funds/bank',
      action: 'Categorize and post',
    })
  }
  if (draftCount > 0) {
    issues.push({
      level: 'blocker',
      title: `${draftCount} journal entr${draftCount === 1 ? 'y is' : 'ies are'} still in draft`,
      detail: 'A draft has no effect on the ledger. Post or void it before closing the period it falls in.',
      href: '/funds/journal',
      action: 'Review the journal',
    })
  }

  // Transactions the ledger does not carry yet — the backfill puts them there (investment-backfill.ts).
  let backlog: Awaited<ReturnType<typeof backfillDerivedEntries>> | null = null
  if (!manco) {
    try {
      // review: builds each waiting entry, so a row with nothing to book is not counted as waiting.
      backlog = await backfillDerivedEntries(admin, fundId, group, null, { dryRun: true, review: true })
    } catch (e) {
      console.error('[status] backlog dry run failed', e instanceof Error ? e.message : e)
      issues.push({ level: 'info', title: 'Could not check which investment items are not on the ledger', detail: 'Everything else on this page is current. Reload to check again.' })
    }
  }
  const notOnLedger = backlog ? backlog.toAdopt + backlog.toDerive + backlog.toPost : 0
  const conflicted = backlog?.conflicted ?? []
  if (conflicted.length > 0) {
    issues.push({
      level: 'blocker',
      title: `${conflicted.length} investment position${conflicted.length === 1 ? ' is' : 's are'} carried by both the tracker and the journal`,
      detail: `${conflicted.slice(0, 3).join('; ')}${conflicted.length > 3 ? `; and ${conflicted.length - 3} more` : ''}. Booking either side would count them twice, so putting investments on the ledger leaves them alone. Void the duplicate entries or delete the duplicate transactions.`,
      href: '/funds/status#book-investments',
      action: 'Review them',
    })
  }
  // A dry run refuses only one thing: an entry skipped because one of its companies is carried by
  // both sides, which leaves its OTHER companies unowned too. Nothing else would name those.
  const spanning = backlog?.refused ?? []
  if (spanning.length > 0) {
    issues.push({
      level: 'blocker',
      title: `${spanning.length} journal entr${spanning.length === 1 ? 'y waits' : 'ies wait'} on a position carried by both the tracker and the journal`,
      detail: `${spanning.slice(0, 3).join(' ')}${spanning.length > 3 ? ` And ${spanning.length - 3} more.` : ''}`,
      href: '/funds/status#book-investments',
      action: 'Review them',
    })
  }
  if (notOnLedger > 0) {
    issues.push({
      level: 'blocker',
      title: `${notOnLedger} investment item${notOnLedger === 1 ? '' : 's'} not on the ledger`,
      detail: 'The balance sheet and the schedule of investments leave them out until they are booked. Review what each would book and pick which to put on the ledger; each books on its own date.',
      href: '/funds/status#book-investments',
      action: 'Review and book',
    })
  } else if (soi.source === 'tracker' && !soiTies(soi)) {
    issues.push({
      level: 'warning',
      title: 'Schedule of investments does not tie to the ledger',
      detail: `Cost is off by ${soi.costVariance.toFixed(2)} and fair value by ${soi.fairValueVariance.toFixed(2)}. A mark or purchase was recorded in one system and not the other.`,
      href: '/funds/schedule-of-investments',
      action: 'Open the schedule',
    })
  }

  // Per-company accounts exist but a position disagrees with its own account.
  const offRows = soi.rows.filter(r => r.tiesOut === false)
  if (offRows.length > 0) {
    issues.push({
      level: 'warning',
      title: `${offRows.length} ${offRows.length === 1 ? 'investment does' : 'investments do'} not tie to the ledger`,
      detail: `${offRows.slice(0, 3).map(r => r.name).join(', ')}${offRows.length > 3 ? `, and ${offRows.length - 3} more` : ''}. The tracker and the ledger disagree on cost or fair value for these positions.`,
      href: '/funds/schedule-of-investments',
      action: 'Open the schedule',
    })
  }

  // Exits with escrow booked before proceeds_received had one meaning (lib/portfolio/proceeds.ts).
  // Each was booked with proceeds_received as the cash received; whether that was right depends on
  // what was typed, which only the bank statement says. Never re-derived without a person: this
  // asks. Only looked up when this entity has such an exit, and it never blocks anything.
  const escrowExits = ((txns as any[]) ?? []).filter(t => t.portfolio_group === group && t.transaction_type === 'proceeds' && Number(t.proceeds_escrow ?? 0) > 0)
  if (escrowExits.length > 0) {
    try {
      const review = (await loadEscrowExits(admin, fundId, { vehicles: [group] })).filter(needsReview)
      if (review.length > 0) {
        // Spell out each exit's two readings in money, so the person can hold it up against the bank
        // statement, and open the company where the exit is edited (not the investments list).
        const lines = review.slice(0, 3).map(r => {
          const bookedCash = r.booked?.cash ?? r.proceedsReceived
          return `${r.company}, ${r.date ?? 'undated'}${r.roundName ? ` (${r.roundName})` : ''}: the books put ${money(bookedCash)} in cash `
            + `and ${money(r.proceedsEscrow)} in escrow. If the bank received ${money(bookedCash)}, raise Proceeds to `
            + `${money(roundCents(bookedCash + r.proceedsEscrow))} (cash stays the same). If it received `
            + `${money(roundCents(bookedCash - r.proceedsEscrow))}, open the exit and save it to book it again.`
        })
        const companyIds = Array.from(new Set(review.map(r => r.companyId)))
        issues.push({
          level: 'warning',
          title: `Check what the bank received for ${review.length} exit${review.length === 1 ? '' : 's'} with escrow`,
          detail: `${lines.join(' ')}${review.length > 3 ? ` And ${review.length - 3} more.` : ''} `
            + 'Proceeds means the full price including escrow; these were booked when it meant the cash received.',
          href: companyIds.length === 1 ? `/companies/${companyIds[0]}?entity=${encodeURIComponent(group)}` : '/investments',
          action: companyIds.length === 1 ? `Open ${review[0].company}` : 'Open the investments',
        })
      }
    } catch (e) {
      console.error('[status] escrow exit review failed', e instanceof Error ? e.message : e)
    }
  }

  if (Math.abs(bs.partnersCapital.unallocatedEarnings) > 0.004) {
    issues.push({
      level: 'warning',
      title: `${bs.partnersCapital.unallocatedEarnings.toFixed(2)} of net income ${ownerEquity ? 'not yet closed to equity' : 'not allocated'}`,
      detail: ownerEquity
        ? `Close the period to transfer its net income into ${equityLabel(kind).toLowerCase()}.`
        : "Fund-level statements are right, but each partner's capital account understates their NAV until the period is closed.",
      href: '/funds/periods',
      action: 'Close the period',
    })
  }

  // DOES THE SUM OF THE PARTNERS EQUAL THE FUND?
  //
  // Both halves were already computed here and never compared. The balance sheet can balance
  // perfectly while the per-partner capital accounts do NOT add up to partners' capital —
  // a posting to the pooled 3100/3000 with no lp_entity_id, or an LP entity deleted out from
  // under its postings, does exactly that. Fund-level statements stay right; every LP's
  // statement is then wrong, and nothing said so.
  //
  // The reconciling items are legitimate and expected: earnings not yet allocated to partners
  // (they sit in the bridge until the close), and GP capital held outside the LP accounts.
  const reconciled = roundCents(nav + bs.partnersCapital.unallocatedEarnings)
  const capitalGap = roundCents(bs.partnersCapital.total - reconciled)

  // An owner's-equity vehicle (a management company, an individual) has no partner accounts to
  // tie to and nobody to hold a commitment: every check in this block is about partners, and
  // for those kinds each would fire forever. See lib/vehicle-kinds.ts closesToOwnerEquity.
  if (!ownerEquity && Math.abs(capitalGap) > 0.004) {
    // Name the postings behind the gap. A posting on a partner's OWN capital account that carries
    // no partner tag is left out of every capital account (the roll-forward reads the tag), and so
    // is anything on the pooled account. Either way the fix is to give the posting its partner.
    const untagged = untaggedCapitalPostings(accounts, sourcedPostings)
    const owners = untagged.length ? await partnerNames(admin, fundId, untagged.map(u => u.ownerId).filter((id): id is string => !!id)) : new Map<string, string>()
    const untaggedTotal = roundCents(untagged.reduce((t, u) => t + u.amount, 0))
    const explains = untagged.length > 0 && Math.abs(roundCents(-untaggedTotal - capitalGap)) < 0.01
    const list = untagged.slice(0, 4).map(u =>
      `${u.date ?? 'undated'} ${money(u.amount)} on ${u.ownerId ? `${owners.get(u.ownerId) ?? 'a partner'}'s account` : 'the pooled account'}${u.memo ? ` ("${u.memo.length > 60 ? `${u.memo.slice(0, 57)}…` : u.memo}")` : ''}`)
    issues.push({
      level: 'blocker',
      title: `${money(capitalGap)} of partners' capital belongs to no partner`,
      detail:
        `The balance sheet shows ${money(bs.partnersCapital.total)} of partners' capital, but the partners' own capital accounts ` +
        `(plus earnings not yet allocated) add up to ${money(reconciled)}, so every LP statement leaves out ${money(capitalGap)}. ` +
        (untagged.length > 0
          ? `${untagged.length} posting${untagged.length === 1 ? '' : 's'} on capital accounts carry no partner${explains ? ', which is the whole gap' : ''}: ${list.join('; ')}${untagged.length > 4 ? `; and ${untagged.length - 4} more` : ''}. `
            + 'Edit each entry and set the partner on its capital line (the partner whose account it is).'
          : 'Look for capital postings whose partner was removed.'),
      href: '/funds/journal',
      action: 'Open the journal',
    })
  }

  if (!ownerEquity && partnersWithCommitment === 0 && owners.length > 0) {
    issues.push({ level: 'warning', title: 'No partner has a commitment', detail: 'The close allocates pro-rata by commitment; with none set there is nothing to allocate on.', href: '/funds/status', action: 'Set commitments' })
  }
  if (!ownerEquity && owners.length === 0) {
    issues.push({ level: 'warning', title: 'No partners yet', detail: 'Add the LPs and GP entity that hold capital in this vehicle.', href: '/funds/capital-accounts', action: 'Add partners' })
  }

  if (manco && chartSeeded && !hasPostedEntries) {
    issues.push({ level: 'info', title: 'No posted entries yet', detail: 'Import your existing books or record the first transaction to start tracking income, expenses, and cash.', href: '/funds/migrate', action: 'Import books' })
  }
  const outstanding = balances.filter(b => Math.abs(b.dueFrom) >= 0.005 || Math.abs(b.dueTo) >= 0.005)
  if (outstanding.length > 0) {
    issues.push({ level: 'info', title: `${outstanding.length} outstanding intercompany balance${outstanding.length === 1 ? '' : 's'}`, detail: 'Review management fees, expense reimbursements, and other amounts due between entities. Settle charges when payment is recorded.', href: '/funds/status#intercompany', action: 'Review balances' })
  }

  return {
    vehicle: group,
    setup: {
      chartSeeded,
      accountCount: accounts.length,
      hasPostedEntries,
      partnerCount: owners.length,
      partnersWithCommitment,
      capitalAttributed,
      stranded,
    },
    investments: {
      trackerPositions: positions.length,
      trackerCost: roundCents(positions.reduce((s, p) => s + p.cost, 0)),
      trackerFairValue: roundCents(positions.reduce((s, p) => s + p.fairValue, 0)),
      ledgerCost: soi.ledgerCost,
      ledgerFairValue: soi.ledgerFairValue,
      offLedger: soi.rows.filter(r => r.tiesOut === false).length,
    },
    ledger: {
      entryCount: entries.length,
      draftCount,
      postedCount,
      trialBalanced: Math.abs(bs.check) < 0.005,
      nav: roundCents(nav),
      netAssets: bs.partnersCapital.total,
      /** Does Σ per-partner capital (+ unallocated earnings) equal partners' capital?
       *  The books can balance while this does not — see the blocker above. */
      capitalTies: Math.abs(capitalGap) < 0.005,
      capitalGap,
    },
    close: {
      basis,
      lastClosedEnd: lastClosed?.period_end ?? null,
      lastClosedLabel: lastClosed?.label ?? null,
      nextStart,
      unallocatedEarnings: bs.partnersCapital.unallocatedEarnings,
    },
    bank: { total: bank.length, needsAttention: bankNeedsAttention },
    issues,
  }
}

const money = (n: number) => {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `(${abs})` : abs
}

/** Partner names by lp_entities id, for naming partners in a warning. Missing ids are left out. */
async function partnerNames(admin: SupabaseClient, fundId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return new Map()
  const { data } = await admin.from('lp_entities' as any).select('id, entity_name').eq('fund_id', fundId).in('id', unique)
  return new Map(((data as any[]) ?? []).map(r => [r.id as string, r.entity_name as string]))
}

export interface UntaggedCapitalPosting { entryId: string; date: string | null; memo: string | null; amount: number; ownerId: string | null }

/**
 * Postings on LP capital accounts that reach no partner's capital account: on a partner's own
 * account (3100-<partner>) without the partner tag, or on the pooled LP capital account. Newest
 * first. `ownerId` is the account's partner, null for the pooled account.
 */
export function untaggedCapitalPostings(
  accounts: { id: string; subtype?: string | null; lpEntityId?: string | null }[],
  postings: { entryId: string; accountId: string; amount: number; lpEntityId?: string | null; entryDate?: string | null; memo?: string | null }[],
): UntaggedCapitalPosting[] {
  const owner = new Map(accounts.filter(a => a.lpEntityId).map(a => [a.id, a.lpEntityId as string]))
  const pooled = new Set(accounts.filter(a => a.subtype === 'lp_capital' && !a.lpEntityId).map(a => a.id))
  return postings
    .filter(p => Math.abs(p.amount) >= 0.005 && ((owner.has(p.accountId) && !p.lpEntityId) || pooled.has(p.accountId)))
    .map(p => ({ entryId: p.entryId, date: p.entryDate ?? null, memo: p.memo ?? null, amount: roundCents(p.amount), ownerId: owner.get(p.accountId) ?? null }))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
}
