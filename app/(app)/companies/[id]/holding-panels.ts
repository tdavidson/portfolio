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

/** The entity the page opens on: the one a link named, if the viewer has it; else the only one. */
export function initialEntity(entities: { id: string }[], requested: string | null | undefined): string | null {
  if (requested && entities.some(e => e.id === requested)) return requested
  return entities.length === 1 ? entities[0].id : null
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
