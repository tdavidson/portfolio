// app/(app)/companies/[id]/holding-panels.ts
//
// Which panels a holding's page shows, by kind. Companies, fund holdings and digital assets all
// live on /companies/[id] (plans/spec-ledger-one-writer.md §6); each is created, recorded and
// configured there. One pure switch, so the page cannot drift into showing a token MRR charts or
// a fund a wallet panel.

export type HoldingKind = 'company' | 'fund' | 'crypto'

export interface HoldingPanels {
  /** The AI analyst summary. A fund holding has one too — it reads the manager's reports and documents. */
  aiSummary: boolean
  /** The KPI metric charts (user-entered or extracted time series). A fund holding may track some. */
  metricCharts: boolean
  /** The MRR/cash highlights, stage and industry, founders and overview. */
  companyProfile: boolean
  /** The fund-of-funds register (FundHoldingDetail), with its position-over-time chart. */
  register: boolean
  /** Reporting updates captured from the company's emails. Those attach only to companies. */
  updates: boolean
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
    aiSummary: k === 'company' || k === 'fund',
    metricCharts: k === 'company' || k === 'fund',
    companyProfile: k === 'company',
    register: k === 'fund',
    updates: k === 'company',
    wallets: k === 'crypto',
    priceFeed: k !== 'fund',
    units: k === 'crypto',
  }
}

/** The page settings a person sets per holding in its edit dialog (and update_company). */
export interface HoldingPageSettings {
  metrics_enabled?: boolean | null
  analyst_enabled?: boolean | null
  price_feed_enabled?: boolean | null
}

/**
 * Which optional sections a holding's page shows, from its kind and its own settings. A setting
 * missing from the row (a demo snapshot recorded before the columns existed) keeps the old
 * behaviour: metrics and the analyst on. A price feed shows when the holding already has one, on a
 * digital asset (always marked from a feed), or when a company has it turned on to add one.
 */
export function holdingSections(
  kind: HoldingKind | null | undefined,
  settings: HoldingPageSettings | null | undefined,
  hasPriceFeed: boolean,
): { metrics: boolean; analyst: boolean; priceFeed: boolean } {
  const p = holdingPanels(kind)
  return {
    metrics: p.metricCharts && settings?.metrics_enabled !== false,
    analyst: p.aiSummary && settings?.analyst_enabled !== false,
    priceFeed: p.priceFeed && (hasPriceFeed || (kind ?? 'company') === 'crypto' || settings?.price_feed_enabled === true),
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
