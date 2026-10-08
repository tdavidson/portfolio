// app/(app)/companies/[id]/holding-panels.ts
//
// Which panels a holding's page shows, by kind. Companies, fund holdings and digital assets all
// live on /companies/[id] (plans/spec-ledger-one-writer.md §6); each is created, recorded and
// configured there. One pure switch, so the page cannot drift into showing a token MRR charts or
// a fund a wallet panel.

export type HoldingKind = 'company' | 'fund' | 'crypto'

export interface HoldingPanels {
  /** AI summary, metric charts, the MRR/cash highlights, founders and overview. */
  companyProfile: boolean
  /** The fund-of-funds register (FundHoldingDetail). */
  register: boolean
  /** Watched wallets. */
  wallets: boolean
  /** The price feed it marks from — a listed company's ticker, or a token's. */
  priceFeed: boolean
  /** Show the unit count beside cost and value. */
  units: boolean
}

export function holdingPanels(kind: HoldingKind | null | undefined): HoldingPanels {
  const k = kind ?? 'company'
  return {
    companyProfile: k === 'company',
    register: k === 'fund',
    wallets: k === 'crypto',
    priceFeed: k !== 'fund',
    units: k === 'crypto',
  }
}

/** Whether the page needs the viewer's entities of the holding: only the per-entity panels (the
 *  fund register, the wallets) read them. */
export function needsEntities(kind: HoldingKind | null | undefined): boolean {
  const p = holdingPanels(kind)
  return p.register || p.wallets
}

/** The entity the page opens on: the one a link named, if the viewer has it; else the only one. */
export function initialEntity(entities: { id: string }[], requested: string | null | undefined): string | null {
  if (requested && entities.some(e => e.id === requested)) return requested
  return entities.length === 1 ? entities[0].id : null
}

/**
 * The date the page opens on, from `?asOf=` — the close's quote blocker links with the period end
 * (holdingHref), so the price feed's marks start on the period the close is missing. Only a real
 * YYYY-MM-DD date is honoured; anything else opens on today, as before.
 */
export function initialAsOf(requested: string | string[] | null | undefined): string | null {
  if (typeof requested !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(requested)) return null
  const d = new Date(`${requested}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === requested ? requested : null
}

/** A quote's basis in the words the fair value hierarchy uses. */
export function quoteBasisNote(q: { as_of_date: string; basis: 'close' | 'intraday' | 'indicative' } | null): string {
  if (!q) return 'No quote stored yet'
  if (q.basis === 'close') return `Official close, ${q.as_of_date}`
  if (q.basis === 'intraday') return `Intraday price, ${q.as_of_date} — Level 2, not an official close`
  return `Indicative price, ${q.as_of_date} — Level 2`
}

const units = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 })

/** One entity's chain-versus-books disagreement, as a sentence. */
export function chainVarianceText(v: { entity: string; observedUnits: number; recordedUnits: number; delta: number; asOf: string | null }): string {
  return `${v.entity}: the chain shows ${units(v.observedUnits)} units at ${v.asOf ?? 'an unknown date'}, the books record `
    + `${units(v.recordedUnits)} — ${units(Math.abs(v.delta))} ${v.delta > 0 ? 'more on-chain than recorded' : 'fewer on-chain than recorded'}.`
}
