import type { CapitalPosting } from './capital-account'
import { computeCapitalAccounts, emptyAccount } from './capital-account'
import { positionsToPostings, type LpPosition } from './lp-positions'

export const REPORTING_DEFINITION_VERSION = 'capital-v1'
export interface ReviewedPeriod { start: string; end: string }

/**
 * An opening entry that REPRESENTS a statement observation (`capital_opening_links`).
 *
 * This is what makes a cutover expressible: the books start at a dated statement, and that
 * statement is not also an independent anchor competing with them. `observedNav`/`bookedAmount`
 * are the figures frozen when the link was made, so a restated statement or an edited entry shows
 * up as a difference instead of quietly changing which basis wins.
 */
export interface OpeningLink {
  lpEntityId: string
  positionId: string
  entryId: string
  observedOn: string
  observedNav: number | null
  bookedAmount: number
}

/** All days from the observation through the report must be reviewed, with no gaps. */
export function coversReportingInterval(periods: ReviewedPeriod[], start: string, end: string): boolean {
  let next = start
  for (const period of [...periods].sort((a, b) => a.start.localeCompare(b.start))) {
    if (period.end < next) continue
    if (period.start > next) return false
    if (period.end >= end) return true
    const day = new Date(`${period.end}T00:00:00Z`)
    day.setUTCDate(day.getUTCDate() + 1)
    next = day.toISOString().slice(0, 10)
  }
  return false
}

export interface CapitalEvidence {
  values: { contributions: number | null; distributions: number | null; nav: number | null }
  basis: 'reported' | 'ledger' | 'missing'
  asOf: string | null
  reportedIrr: number | null
  canCalculateIrr: boolean
  missing: ('contributions' | 'distributions' | 'nav')[]
  conflict: boolean
  ledgerThrough: string | null
  /** Observations describe balances, not transaction dates. */
  observationDates: string[]
  entryIds: string[]
  /**
   * Whether closed periods cover this partner's figures through the report date. A label for the
   * reader, never a switch: the books are reported either way.
   */
  reviewed: boolean
  anchor?: {
    positionId: string | null; date: string; agreesWithBooks: boolean; supportingEntryIds: string[]
    /** Books less the imported figure on the import's date, per field; null where the import left it blank. */
    variance?: { contributions: number | null; distributions: number | null; nav: number | null }
  }
  /** The statement observations this partner's books already represent, newest last. */
  representedObservations?: { positionId: string; date: string; entryId: string; restated: boolean }[]
}

/** Resolve each partner independently. A chart or an unrelated entry cannot select a source.
 * Observations and postings are alternate representations; they are never added together.
 *
 * THE BOOKS ARE THE RECORD. A partner with capital activity in the ledger reports from the ledger.
 * An imported observation (a statement, a migrated register) is then a cross-check: where the books
 * disagree with it on its date, `conflict` and `anchor.variance` say so, and the figures still come
 * from the books. Only a partner with no capital activity in the ledger reports the observation.
 *
 * This used to run the other way: an observation won unless the books tied to it to the cent AND
 * closed periods covered every day since, a rule written when the app kept no books. It left funds
 * whose books were current reporting a months-old import with no IRR, and nothing on screen said
 * the books were being ignored. Closed periods now only label the result (`reviewed`).
 */
export function resolveCapitalEvidence(
  ledger: CapitalPosting[], positions: LpPosition[], asOf?: string, closedThrough?: string | null, reviewedPeriods?: ReviewedPeriod[],
  openingLinks?: OpeningLink[],
): { postings: CapitalPosting[]; evidenceByLp: Map<string, CapitalEvidence> } {
  const scopedLedger = ledger.filter(p => !asOf || (!!p.entryDate && p.entryDate <= asOf))
  const scopedPositions = positions.filter(p => !asOf || p.asOfDate <= asOf)
  const ids = new Set([...scopedLedger.map(p => p.lpEntityId), ...scopedPositions.map(p => p.lpEntityId)].filter(Boolean) as string[])
  const postings: CapitalPosting[] = []
  const evidenceByLp = new Map<string, CapitalEvidence>()
  for (const id of ids) {
    const lpLedger = scopedLedger.filter(p => p.lpEntityId === id)
    if (new Set(lpLedger.map(p => p.currency).filter(Boolean)).size > 1) throw new Error(`Multiple currencies in capital records for ${id}; translate them to one reporting currency before reporting.`)
    const allObservations = scopedPositions.filter(p => p.lpEntityId === id).sort((a, b) => a.asOfDate.localeCompare(b.asOfDate))

    // AN OBSERVATION THE BOOKS ALREADY REPRESENT IS NOT A COMPETING ANCHOR. The opening entry IS
    // that statement, recorded as such, so counting the statement as a separate reported balance
    // would be the second representation of one fact — the "do not add another 120" rule. Only a
    // link whose entry is actually in this partner's scoped ledger counts: one dated after `asOf`
    // has not happened yet as far as this report is concerned.
    const entryIdsInScope = new Set(lpLedger.map(p => p.entryId).filter((e): e is string => !!e))
    const links = (openingLinks ?? []).filter(l => l.lpEntityId === id && entryIdsInScope.has(l.entryId))
    const representedIds = new Set(links.map(l => l.positionId))
    const represented = links
      .map(l => {
        const observation = allObservations.find(p => p.id === l.positionId)
        return {
          positionId: l.positionId, date: l.observedOn, entryId: l.entryId,
          // The statement was edited after the books were started from it, or the entry was.
          restated: !!observation && observation.nav != null && l.observedNav != null
            && Math.abs(observation.nav - l.observedNav) >= 0.005,
        }
      })
      .sort((a, b) => a.date.localeCompare(b.date))
    const observations = allObservations.filter(p => !p.id || !representedIds.has(p.id))
    const latest = observations.at(-1)
    const ledgerThrough = lpLedger.reduce<string | null>((date, p) => p.entryDate && (!date || p.entryDate > date) ? p.entryDate : date, null)
    // Blank fields on the import, which matter only when the import is what gets reported.
    const blank: CapitalEvidence['missing'] = []
    if (latest?.calledCapital == null && latest) blank.push('contributions')
    if (latest?.distributions == null && latest) blank.push('distributions')
    if (latest?.nav == null && latest) blank.push('nav')
    const atObservation = latest ? computeCapitalAccounts(lpLedger, { end: latest.asOfDate }).get(id) ?? emptyAccount() : null
    const ties = !!latest && blank.length === 0 && !!atObservation &&
      Math.abs(atObservation.contributions - latest.calledCapital!) < 0.005 &&
      Math.abs(-atObservation.distributions - latest.distributions!) < 0.005 &&
      Math.abs(atObservation.ending - latest.nav!) < 0.005
    const reportDate = asOf ?? [ledgerThrough, latest?.asOfDate].filter(Boolean).sort().at(-1)
    // Reviewed from the first day there is anything to review: the import's date when the books
    // agree with it (so the import vouches for everything before), otherwise the first entry.
    const firstEntry = lpLedger.reduce<string | null>((date, p) => p.entryDate && (!date || p.entryDate < date) ? p.entryDate : date, null)
    const reviewFrom = latest && ties ? latest.asOfDate : firstEntry ?? latest?.asOfDate ?? null
    const reviewed = !!reportDate && !!reviewFrom && (reviewedPeriods !== undefined
      ? coversReportingInterval(reviewedPeriods, reviewFrom, reportDate)
      : !!closedThrough && closedThrough >= reportDate)
    const diff = (books: number, imported: number | null | undefined) => imported == null ? null : (Math.round((books - imported) * 100) / 100 || 0)
    const variance = latest && atObservation && lpLedger.length > 0 ? {
      contributions: diff(atObservation.contributions, latest.calledCapital),
      distributions: diff(-atObservation.distributions, latest.distributions),
      nav: diff(atObservation.ending, latest.nav),
    } : undefined
    const useLedger = lpLedger.length > 0 || !latest
    const basis = useLedger ? 'ledger' : 'reported'
    const missing: CapitalEvidence['missing'] = useLedger ? [] : blank
    if (useLedger) postings.push(...lpLedger)
    // Numeric compatibility postings exist only for COMPLETE observations; metadata retains
    // missing fields. Never synthesize a zero NAV from a partial statement.
    else if (missing.length === 0) postings.push(...positionsToPostings(observations.filter(p => p.calledCapital != null && p.distributions != null && p.nav != null)))
    // A recorded link is the fact; the source-type regex stays as the fallback for opening entries
    // booked before links existed. Either way an opening balance is a starting position, not a
    // dated cash flow, so an IRR cannot be calculated from it. Opening entries that net to nothing
    // (a duplicate opening and its reversal) leave no starting position behind, so they don't count.
    const openingNet = lpLedger.filter(p => /opening|bootstrap|cutover/.test(p.sourceType ?? '')).reduce((sum, p) => sum + p.amount, 0)
    const openingOnly = links.length > 0 || Math.abs(openingNet) >= 0.005
    const balance = computeCapitalAccounts(lpLedger).get(id) ?? emptyAccount()
    evidenceByLp.set(id, {
      values: useLedger ? { contributions: balance.contributions, distributions: -balance.distributions || 0, nav: balance.ending } : { contributions: latest!.calledCapital, distributions: latest!.distributions, nav: latest!.nav },
      basis, asOf: useLedger ? (asOf ?? ledgerThrough) : latest!.asOfDate,
      reportedIrr: latest?.irr ?? null,
      canCalculateIrr: useLedger && !openingOnly && lpLedger.length > 0,
      // A statement that was restated after the books were started from it is a disagreement
      // between two representations of one fact, so it surfaces rather than being absorbed.
      missing, conflict: represented.some(r => r.restated) || !!latest && lpLedger.length > 0 && !!atObservation && (
        (latest.calledCapital != null && Math.abs(atObservation.contributions - latest.calledCapital) >= 0.005) ||
        (latest.distributions != null && Math.abs(-atObservation.distributions - latest.distributions) >= 0.005) ||
        (latest.nav != null && Math.abs(atObservation.ending - latest.nav) >= 0.005)
      ),
      ledgerThrough, observationDates: allObservations.map(p => p.asOfDate),
      ...(represented.length > 0 ? { representedObservations: represented } : {}),
      reviewed,
      ...(latest ? { anchor: { positionId: latest.id ?? null, date: latest.asOfDate, agreesWithBooks: ties, ...(variance ? { variance } : {}), supportingEntryIds: Array.from(new Set(lpLedger.filter(p => p.entryDate && p.entryDate <= latest.asOfDate).map(p => p.entryId).filter((id): id is string => !!id))) } } : {}),
      entryIds: Array.from(new Set(lpLedger.map(p => p.entryId).filter((id): id is string => !!id))),
    })
  }
  return { postings, evidenceByLp }
}
