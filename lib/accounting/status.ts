// Entity book health, data completeness, and reconciliation work. No activation state.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPostedLedger, loadOwnership } from './load'
import { loadStrandedCapital, type StrandedCapital } from './pooled-capital-check'
import { balanceSheet, scheduleOfInvestments, postingsAsOf } from './statements'
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
    { accounts, postings, capitalPostings },
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

  const bs = balanceSheet(accounts, postingsAsOf(postings, null), { equityLabel: equityLabel(kind) })
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
    const conflicts = evidence.filter(e => e.conflict).length
    const incomplete = evidence.filter(e => e.missing.length > 0).length
    const dates = evidence.filter(e => e.basis === 'reported').map(e => e.asOf!).sort()
    if (conflicts) issues.push({ level: 'warning', title: `${conflicts} reported balance${conflicts === 1 ? '' : 's'} differ from the books`, detail: 'Reported balances remain visible until the overlapping accounting records reconcile. Review the differences before relying on a combined report.', href: '/funds/capital-accounts', action: 'Reconcile balances' })
    if (incomplete) issues.push({ level: 'warning', title: `${incomplete} incomplete capital position${incomplete === 1 ? '' : 's'}`, detail: 'Missing amounts appear as a dash, including totals that depend on them. Enter the missing contributions, distributions, or NAV.', href: '/funds/capital-accounts', action: 'Review balances' })
    if (dates.length) issues.push({ level: 'info', title: 'Check limited partner capital accounts', detail: `These balances are dated ${dates[0]}${dates.at(-1) !== dates[0] ? ` through ${dates.at(-1)}` : ''}. A later journal entry does not update their valuation date.`, href: '/funds/capital-accounts', action: 'View balances' })
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
      backlog = await backfillDerivedEntries(admin, fundId, group, null, { dryRun: true })
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
      detail: 'The balance sheet and the schedule of investments leave them out until they are booked. Putting them on the ledger books each on its own date, and running it again books nothing twice.',
      href: '/funds/status#book-investments',
      action: 'Put them on the ledger',
    })
  } else if (soi.source === 'tracker' && (soi.costVariance !== 0 || soi.fairValueVariance !== 0)) {
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
    issues.push({
      level: 'blocker',
      title: "Partners' capital doesn't tie to the sum of the partners",
      detail:
        `Partners' capital is ${bs.partnersCapital.total.toFixed(2)}, but the individual capital accounts ` +
        `plus unallocated earnings come to ${reconciled.toFixed(2)} — a gap of ${capitalGap.toFixed(2)}. ` +
        `Something is booked to partners' capital without being attributed to a partner, so every LP statement understates or overstates. ` +
        `Look for postings to the pooled capital account (3100/3000) that carry no partner.`,
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
