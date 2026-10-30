/**
 * An investor's own dated capital movements, for the portal's Activity tab.
 *
 * Pure: the caller loads each vehicle's capital postings and positions, already kept to this
 * investor's entities. What comes out is safe to show the investor:
 *
 * - Every line is described from its kind ("Capital call", "Distribution"), never from the entry's
 *   memo. One entry usually covers every partner, and its memo can name any of them.
 * - Lines are summed per vehicle, entity, date and kind, so an entry split across several accounts
 *   reads as one movement.
 * - A vehicle tracked only by pasted positions has no transactions, just quarter-end totals, so its
 *   lines are the change in called capital and distributions between two statements, marked
 *   `quarterly` so the page can say so.
 */
import { bucketForSourceType, RECYCLED_PROCEEDS_SOURCE, type CapitalPosting } from '@/lib/accounting/capital-account'
import type { LpPosition } from '@/lib/accounting/lp-positions'

export type ActivityKind =
  | 'contribution'
  | 'distribution'
  | 'reinvestment'
  | 'transfer_in'
  | 'transfer_out'
  | 'secondary_purchase'
  | 'secondary_sale'

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  contribution: 'Capital call',
  distribution: 'Distribution',
  reinvestment: 'Reinvested distribution',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  secondary_purchase: 'Secondary purchase',
  secondary_sale: 'Secondary sale',
}

export interface ActivityLine {
  date: string
  vehicle: string
  entityId: string
  entityName: string
  kind: ActivityKind
  label: string
  /** Always positive; `kind` says which way it moved. */
  amount: number
  /** `transaction` from the books; `quarterly` the change between two position statements. */
  detail: 'transaction' | 'quarterly'
  /** For a quarterly line, the statement date it is measured from. */
  since?: string
  /** The notice behind this line, when the call or distribution was made in the app. */
  notice?: NoticeLink
}

/** A capital call or distribution line in the app, which the portal's Notices tab shows. */
export interface NoticeLink {
  lineId: string
  kind: 'capital_call' | 'distribution'
}

export interface VehicleActivityInput {
  vehicle: string
  postings: CapitalPosting[]
  positions: LpPosition[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** What a capital posting is, from the investor's side; null when it is not a movement they made. */
export function activityKind(p: Pick<CapitalPosting, 'sourceType' | 'amount'>): ActivityKind | null {
  // Debit-positive: a contribution credits the partner's capital (negative amount).
  const into = p.amount < 0
  if (p.sourceType === 'transfer') return into ? 'transfer_in' : 'transfer_out'
  if (p.sourceType === 'secondary_transfer') return into ? 'secondary_purchase' : 'secondary_sale'
  const bucket = bucketForSourceType(p.sourceType, p.amount)
  if (bucket === 'contributions') return p.sourceType === RECYCLED_PROCEEDS_SOURCE ? 'reinvestment' : 'contribution'
  if (bucket === 'distributions') return 'distribution'
  return null
}

/**
 * @param notices in-app call and distribution lines keyed `${journal entry id}|${entity id}`: a
 *   line built from that entry, for that entity, links to its notice.
 */
export function buildActivity(
  vehicles: VehicleActivityInput[],
  entityNames: Map<string, string>,
  notices: Map<string, NoticeLink> = new Map(),
): ActivityLine[] {
  const lines: ActivityLine[] = []
  for (const v of vehicles) {
    const sums = new Map<string, ActivityLine>()
    const ledgerThrough = new Map<string, string>()
    for (const p of v.postings) {
      if (!p.entryDate || !p.lpEntityId || !entityNames.has(p.lpEntityId)) continue
      const kind = activityKind(p)
      if (!kind) continue
      const through = ledgerThrough.get(p.lpEntityId)
      if (!through || p.entryDate > through) ledgerThrough.set(p.lpEntityId, p.entryDate)
      const key = `${p.lpEntityId}|${p.entryDate}|${kind}`
      const line = sums.get(key) ?? {
        date: p.entryDate, vehicle: v.vehicle, entityId: p.lpEntityId, entityName: entityNames.get(p.lpEntityId)!,
        kind, label: ACTIVITY_LABELS[kind], amount: 0, detail: 'transaction' as const,
      }
      line.amount += Math.abs(p.amount)
      const notice = p.entryId ? notices.get(`${p.entryId}|${p.lpEntityId}`) : undefined
      const fits = notice && (notice.kind === 'capital_call' ? kind === 'contribution' : kind === 'distribution')
      if (fits && !line.notice) line.notice = notice
      sums.set(key, line)
    }
    for (const line of Array.from(sums.values())) {
      line.amount = round2(line.amount)
      if (line.amount >= 0.005) lines.push(line)
    }

    // Statements, where the books have nothing for this entity yet: the change between each
    // statement and the one before it. The first statement has nothing to compare with.
    const byEntity = new Map<string, LpPosition[]>()
    for (const pos of v.positions) {
      if (!entityNames.has(pos.lpEntityId)) continue
      byEntity.set(pos.lpEntityId, [...(byEntity.get(pos.lpEntityId) ?? []), pos])
    }
    for (const [entityId, list] of Array.from(byEntity.entries())) {
      const sorted = list.sort((a, b) => a.asOfDate.localeCompare(b.asOfDate))
      const through = ledgerThrough.get(entityId)
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1], cur = sorted[i]
        if (through && cur.asOfDate <= through) continue
        const add = (kind: ActivityKind, before: number | null, after: number | null) => {
          if (before == null || after == null) return
          const change = round2(after - before)
          if (change < 0.005) return
          lines.push({
            date: cur.asOfDate, vehicle: v.vehicle, entityId, entityName: entityNames.get(entityId)!,
            kind, label: ACTIVITY_LABELS[kind], amount: change, detail: 'quarterly', since: prev.asOfDate,
          })
        }
        add('contribution', prev.calledCapital, cur.calledCapital)
        add('distribution', prev.distributions, cur.distributions)
      }
    }
  }
  // Newest first; within a day, by vehicle then kind so the order is stable.
  return lines.sort((a, b) => b.date.localeCompare(a.date) || a.vehicle.localeCompare(b.vehicle) || a.entityName.localeCompare(b.entityName) || a.kind.localeCompare(b.kind))
}
