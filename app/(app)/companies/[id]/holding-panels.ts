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
