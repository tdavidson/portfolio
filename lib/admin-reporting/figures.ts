// Admin-reported vehicles: what a pull carries, how it is checked, and how it becomes report rows.
//
// A vehicle whose fund administrator keeps the books reports the administrator's figures as stated.
// Nothing here recalculates or second-guesses them: each LP's commitment, paid-in, distributions and
// NAV are stored as given, and every LP's row shows the fund's net LP-only IRR, TVPI and DPI for the
// date. The only checks are that a pull is COMPLETE (every figure the cards need is there) and
// MATCHED (every administrator partner is a known partner of the vehicle, and none went missing).
//
// The card's total row adds an LP's vehicles together and works out a combined DPI and TVPI from the
// sums (components/lp-report-card). That is why commitment, paid-in, distributions and NAV are all
// required per LP: without one of them the total row cannot be made.
//
// Pure: no database or server imports, so the routes, the agent tools and the tests share it.

/**
 * Where an admin vehicle's figures come from: the id of a fund administrator's MCP server this
 * deployment lists (lib/mcp-client/servers.ts, any administrator), or 'csv' / 'other' for figures
 * given by hand. See adapters.ts.
 */
export type AdminProvider = string
export const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
export type RecordSource = 'books' | 'admin'
export type PullChannel = 'app' | 'assistant'

/** One administrator partner's figures on the pull's date. */
export interface AdminPosition {
  /** The administrator's id for the partner (Carta's partner UUID). Falls back to the name. */
  externalId: string
  /** The partner's name at the administrator. */
  name: string
  /** An explicit match to an app partner, when the caller already knows it. */
  lpEntityId?: string | null
  commitment: number | null
  paidIn: number | null
  distributions: number | null
  nav: number | null
  /** Called but not yet funded, where the administrator states it. */
  receivable?: number | null
  /**
   * The carried interest within the partner's account, cumulative to the date, where the
   * administrator states it: positive on a GP's row, negative where it is charged to an LP.
   */
  carriedInterest?: number | null
}

/** The fund's net LP-only figures on the pull's date, shown on every LP's row. */
export interface AdminFundFigures {
  /** A fraction: 0.0608 for 6.08%. */
  irr: number | null
  tvpi: number | null
  dpi: number | null
}

export interface AdminFigures {
  asOf: string
  /** Who the figures come from, as a reader would name it: "Carta", "CSV upload". */
  source: string
  positions: AdminPosition[]
  fund: AdminFundFigures
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const isDate = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v))
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** A money amount as the source states it: 1,250,000.00, "$1,250,000", 1250000. Null when blank. */
export function parseAmount(v: unknown): number | null | 'invalid' {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : 'invalid'
  const s = String(v).trim()
  if (!s || s === '-' || s === '—') return null
  // (1,000) is a negative in accountants' notation.
  const negative = /^\(.*\)$/.test(s)
  const n = Number(s.replace(/[()$,\s]/g, ''))
  if (!Number.isFinite(n)) return 'invalid'
  return Math.round((negative ? -n : n) * 100) / 100
}

/**
 * An IRR as given: "6.08%" or 6.08 is a percent, 0.0608 a fraction (as reported-figures.ts reads
 * them). An IRR above 100% must say "%". Null when blank.
 */
export function parseIrr(v: unknown): number | null | 'invalid' {
  if (v == null) return null
  const raw = typeof v === 'number' ? String(v) : String(v).trim()
  if (!raw) return null
  const percent = /%\s*$/.test(raw)
  const n = Number(raw.replace(/[%,\s]/g, ''))
  if (!Number.isFinite(n)) return 'invalid'
  const value = percent || Math.abs(n) > 1 ? n / 100 : n
  return Math.round(value * 1e8) / 1e8
}

/** A multiple as given: "1.49x" or 1.49. Null when blank. */
export function parseMultiple(v: unknown): number | null | 'invalid' {
  if (v == null) return null
  const raw = typeof v === 'number' ? String(v) : String(v).trim()
  if (!raw) return null
  const n = Number(raw.replace(/[x×,\s]/gi, ''))
  if (!Number.isFinite(n) || n < 0) return 'invalid'
  return Math.round(n * 1e8) / 1e8
}

export const MAX_POSITIONS = 2000

/**
 * The figures a caller passed, normalised, or the first thing wrong with them. Accepts the field
 * names a person or an assistant would use (paid_in or paidIn, external_id or externalId).
 */
export function cleanAdminFigures(input: any): AdminFigures | string {
  if (!input || typeof input !== 'object') return 'figures are required'
  const asOf = input.as_of ?? input.asOf
  if (!isDate(asOf)) return 'as_of must be a date (YYYY-MM-DD)'
  const source = text(input.source, 200)
  if (!source) return 'source is required: name the administrator the figures come from'
  const list = Array.isArray(input.positions) ? input.positions : null
  if (!list || list.length === 0) return 'positions is required: one entry per partner'
  if (list.length > MAX_POSITIONS) return `At most ${MAX_POSITIONS} partners in one pull.`

  const positions: AdminPosition[] = []
  const seen = new Set<string>()
  for (const [i, p] of list.entries()) {
    const at = `positions[${i}]`
    const name = text(p?.name, 300)
    const externalId = text(p?.external_id ?? p?.externalId, 200) ?? name
    if (!externalId || !name) return `${at}: name is required`
    if (seen.has(externalId)) return `${at}: ${name} is given twice`
    seen.add(externalId)
    const amounts: Record<string, number | null> = {}
    for (const [field, keys] of [
      ['commitment', ['commitment']],
      ['paidIn', ['paid_in', 'paidIn', 'called_capital', 'calledCapital', 'contributions']],
      ['distributions', ['distributions']],
      ['nav', ['nav']],
      ['receivable', ['receivable']],
      ['carriedInterest', ['carried_interest', 'carriedInterest']],
    ] as const) {
      const key = keys.find(k => p?.[k] !== undefined)
      const parsed = parseAmount(key ? p[key] : null)
      if (parsed === 'invalid') return `${at}: ${field} must be an amount`
      amounts[field] = parsed
    }
    const lpEntityId = text(p?.lp_entity_id ?? p?.lpEntityId, 64)
    positions.push({
      externalId, name, ...(lpEntityId ? { lpEntityId } : {}),
      commitment: amounts.commitment, paidIn: amounts.paidIn, distributions: amounts.distributions, nav: amounts.nav,
      ...(amounts.receivable != null ? { receivable: amounts.receivable } : {}),
      ...(amounts.carriedInterest != null ? { carriedInterest: amounts.carriedInterest } : {}),
    })
  }

  const f = input.fund ?? {}
  const irr = parseIrr(f.irr ?? f.net_lp_irr)
  if (irr === 'invalid') return 'fund.irr must be a rate: "6.08%" or 0.0608'
  const tvpi = parseMultiple(f.tvpi ?? f.lp_tvpi)
  if (tvpi === 'invalid') return 'fund.tvpi must be a multiple: "1.49x" or 1.49'
  const dpi = parseMultiple(f.dpi ?? f.lp_dpi)
  if (dpi === 'invalid') return 'fund.dpi must be a multiple: "0.10x" or 0.10'

  return { asOf, source, positions, fund: { irr, tvpi, dpi } }
}

// ---------------------------------------------------------------------------
// Matching and flags
// ---------------------------------------------------------------------------

export interface PartnerRef { id: string; name: string }
export interface LinkRef { externalId: string; lpEntityId: string }

export interface PullMatch {
  externalId: string
  name: string
  lpEntityId: string | null
  /** How the match was made: a saved link, the caller's explicit id, or the partner's exact name. */
  by: 'link' | 'explicit' | 'name' | null
}

export interface PullFlags {
  /** Problems that stop the pull from being saved. */
  blocking: string[]
  /** Things to look at that do not stop it. */
  warnings: string[]
  matches: PullMatch[]
  /** Figures that moved from the pull already saved for the same date. */
  changes: { name: string; field: string; from: number | null; to: number | null }[]
}

const norm = (s: string) => s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()
const REQUIRED: { key: keyof AdminPosition; label: string }[] = [
  { key: 'commitment', label: 'commitment' },
  { key: 'paidIn', label: 'paid-in' },
  { key: 'distributions', label: 'distributions' },
  { key: 'nav', label: 'NAV' },
]

/**
 * Check a pull against the vehicle's partners. Never looks at whether a figure is right: the
 * administrator is the record. Blocks only what would leave a card wrong or a partner unplaced.
 *
 * `partners` are the fund's partner entities (a match by name may land on any of them); `vehiclePartnerIds`
 * the ones already in this vehicle's last saved pull, so a partner who drops out is noticed.
 */
export function checkPull(args: {
  figures: AdminFigures
  partners: PartnerRef[]
  links: LinkRef[]
  previous?: { figures: AdminFigures; matches: { externalId: string; lpEntityId: string }[] } | null
}): PullFlags {
  const { figures, partners, links, previous } = args
  const blocking: string[] = []
  const warnings: string[] = []
  const byId = new Map(partners.map(p => [p.id, p]))
  const linked = new Map(links.map(l => [l.externalId, l.lpEntityId]))
  const byName = new Map<string, string[]>()
  for (const p of partners) {
    const k = norm(p.name)
    byName.set(k, [...(byName.get(k) ?? []), p.id])
  }

  const matches: PullMatch[] = figures.positions.map(p => {
    if (p.lpEntityId) {
      return byId.has(p.lpEntityId)
        ? { externalId: p.externalId, name: p.name, lpEntityId: p.lpEntityId, by: 'explicit' as const }
        : { externalId: p.externalId, name: p.name, lpEntityId: null, by: null }
    }
    const link = linked.get(p.externalId)
    if (link && byId.has(link)) return { externalId: p.externalId, name: p.name, lpEntityId: link, by: 'link' as const }
    const named = byName.get(norm(p.name)) ?? []
    if (named.length === 1) return { externalId: p.externalId, name: p.name, lpEntityId: named[0], by: 'name' as const }
    return { externalId: p.externalId, name: p.name, lpEntityId: null, by: null }
  })

  const unmatched = matches.filter(m => !m.lpEntityId)
  if (unmatched.length) {
    blocking.push(`${unmatched.length} partner${unmatched.length === 1 ? ' is' : 's are'} not matched to a partner in the app: ` +
      `${unmatched.slice(0, 10).map(m => m.name).join(', ')}${unmatched.length > 10 ? ', …' : ''}. ` +
      'Add them as partners, or pass lp_entity_id for each.')
  }
  const twice = new Map<string, string[]>()
  for (const m of matches) if (m.lpEntityId) twice.set(m.lpEntityId, [...(twice.get(m.lpEntityId) ?? []), m.name])
  for (const [id, names] of Array.from(twice.entries())) {
    if (names.length > 1) blocking.push(`${names.join(' and ')} both match ${byId.get(id)?.name ?? id}. Give each its own partner.`)
  }
  const byName2 = matches.filter(m => m.by === 'name')
  if (byName2.length) {
    warnings.push(`${byName2.length} partner${byName2.length === 1 ? ' was' : 's were'} matched by name; the match is kept for later pulls once saved.`)
  }

  for (const p of figures.positions) {
    const missing = REQUIRED.filter(r => p[r.key] == null).map(r => r.label)
    if (missing.length) blocking.push(`${p.name} has no ${missing.join(', ')}. The card's totals need all four.`)
  }
  const fundMissing = (['irr', 'tvpi', 'dpi'] as const).filter(k => figures.fund[k] == null)
  if (fundMissing.length) {
    warnings.push(`The fund's net LP-only ${fundMissing.map(k => k.toUpperCase()).join(', ')} ${fundMissing.length === 1 ? 'is' : 'are'} missing for ${figures.asOf}; ` +
      'the LP rows will show it blank.')
  }

  const changes: PullFlags['changes'] = []
  if (previous) {
    const now = new Set(matches.map(m => m.lpEntityId).filter(Boolean))
    const gone = previous.matches.filter(m => !now.has(m.lpEntityId))
    if (gone.length) {
      blocking.push(`${gone.length} partner${gone.length === 1 ? '' : 's'} in the pull saved for ${previous.figures.asOf} ` +
        `${gone.length === 1 ? 'is' : 'are'} missing from this one: ${gone.slice(0, 10).map(g => byId.get(g.lpEntityId)?.name ?? g.externalId).join(', ')}.`)
    }
    if (previous.figures.asOf === figures.asOf) {
      const before = new Map(previous.figures.positions.map(p => [p.externalId, p]))
      for (const p of figures.positions) {
        const b = before.get(p.externalId)
        if (!b) continue
        for (const r of REQUIRED) {
          if ((b[r.key] ?? null) !== (p[r.key] ?? null)) changes.push({ name: p.name, field: r.label, from: (b[r.key] as number | null) ?? null, to: (p[r.key] as number | null) ?? null })
        }
      }
      for (const k of ['irr', 'tvpi', 'dpi'] as const) {
        if ((previous.figures.fund[k] ?? null) !== (figures.fund[k] ?? null)) changes.push({ name: 'Fund', field: k.toUpperCase(), from: previous.figures.fund[k], to: figures.fund[k] })
      }
    }
  }

  return { blocking, warnings, matches, changes }
}

// ---------------------------------------------------------------------------
// Report rows
// ---------------------------------------------------------------------------

/** One stored position, as lp_positions holds it. */
export interface StoredAdminPosition {
  lpEntityId: string
  asOfDate: string
  commitment: number | null
  calledCapital: number | null
  distributions: number | null
  nav: number | null
  receivable?: number | null
  carriedInterest?: number | null
}

export interface AdminRow {
  entity_id: string
  asOf: string
  commitment: number
  called_capital: number | null
  paid_in_capital: number | null
  distributions: number | null
  nav: number | null
  total_value: number | null
  outstanding_balance: number | null
  receivable: number | null
  /** The carried interest within the row, as stated; null where the administrator gives none. */
  carried_interest: number | null
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
  irr: number | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 10000) / 10000

/**
 * Fill in whichever of DPI, RVPI and TVPI the administrator left out, from the other two:
 * TVPI = DPI + RVPI. This is an identity, not a calculation of the app's own, so a figure derived
 * this way says exactly what the administrator's two figures already say (Carta, for one, gives
 * TVPI and DPI but no RVPI). A ratio the administrator did give is never replaced.
 */
export function backfillMultiples<T extends { dpi: number | null; rvpi: number | null; tvpi: number | null }>(m: T): T {
  const { dpi, rvpi, tvpi } = m
  if (rvpi == null && tvpi != null && dpi != null) return { ...m, rvpi: round4(tvpi - dpi) }
  if (dpi == null && tvpi != null && rvpi != null) return { ...m, dpi: round4(tvpi - rvpi) }
  if (tvpi == null && dpi != null && rvpi != null) return { ...m, tvpi: round4(dpi + rvpi) }
  return m
}

/**
 * An admin vehicle's report rows on a date: each LP's latest stored position on or before it, with
 * the fund's net LP-only IRR, TVPI and DPI for THAT position's date (a figure as of another date is
 * not the quarter's, so it is never borrowed). A multiple the administrator leaves out is filled in
 * from the other two (backfillMultiples): Carta keeps no LP-only RVPI, so it is TVPI less DPI.
 *
 * `fundByDate` maps a date to the fund figures recorded for it.
 */
export function adminRows(
  positions: StoredAdminPosition[],
  fundByDate: Map<string, Partial<AdminFundFigures>>,
  asOf?: string,
): AdminRow[] {
  const latest = new Map<string, StoredAdminPosition>()
  for (const p of positions) {
    if (asOf && p.asOfDate > asOf) continue
    const prior = latest.get(p.lpEntityId)
    if (!prior || p.asOfDate > prior.asOfDate) latest.set(p.lpEntityId, p)
  }
  return Array.from(latest.values()).map(p => {
    const fund = fundByDate.get(p.asOfDate) ?? {}
    const commitment = p.commitment ?? 0
    return backfillMultiples({
      entity_id: p.lpEntityId,
      asOf: p.asOfDate,
      commitment,
      called_capital: p.calledCapital,
      paid_in_capital: p.calledCapital,
      distributions: p.distributions,
      nav: p.nav,
      total_value: p.nav == null || p.distributions == null ? null : round2(p.nav + p.distributions),
      // The unfunded commitment as the card shows it: commitment less paid-in, both as stated.
      outstanding_balance: p.calledCapital == null ? null : round2(commitment - p.calledCapital),
      receivable: p.receivable ?? null,
      carried_interest: p.carriedInterest ?? null,
      dpi: fund.dpi ?? null,
      rvpi: null,
      tvpi: fund.tvpi ?? null,
      irr: fund.irr ?? null,
    })
  })
}

// ---------------------------------------------------------------------------
// Look-through: an associate's administrator-stated row in the fund, split across its members
// ---------------------------------------------------------------------------

export interface LookThroughMember { lpEntityId: string; ownershipWeight: number; carryWeight: number }

export interface MemberShare {
  entity_id: string
  commitment: number
  paid_in_capital: number | null
  distributions: number | null
  nav: number | null
}

/**
 * Split a GP/associate partner's row, as the administrator states it, across the associate's own
 * members. The administrator gives one row for the associate; who inside it holds what is the
 * associate's own terms, which the app keeps.
 *
 * The row mixes the associate's own capital with the carry it earned, and the two belong to
 * different people: the capital part follows ownership, the carry follows carry points. Commitment
 * and paid-in follow ownership. Nothing the administrator states is changed: the members' figures
 * add back to the row.
 *
 * Where the administrator states the carry within the row (`carried_interest`), the split uses it:
 * the row's total value less the carry is the capital part. Otherwise the capital part is what the
 * associate's paid-in would have earned at the FUND'S stated LP return (paid-in × LP TVPI). Either
 * way, the capital part's distributions are paid-in × LP DPI (at most the capital part), and the
 * rest of it is NAV.
 *
 * With neither the carry nor the fund's LP TVPI and DPI the two parts can't be told apart, so
 * everything follows ownership.
 */
export function splitAdminRow(
  row: {
    commitment: number; paid_in_capital: number | null; distributions: number | null; nav: number | null
    tvpi: number | null; dpi: number | null; carried_interest?: number | null
  },
  members: LookThroughMember[],
): MemberShare[] {
  if (members.length === 0) return []
  const norm = (ws: number[]) => {
    const t = ws.reduce((a, w) => a + Math.max(0, w), 0)
    return t > 0 ? ws.map(w => Math.max(0, w) / t) : ws.map(() => 0)
  }
  const own = norm(members.map(m => m.ownershipWeight))
  const anyCarry = members.some(m => m.carryWeight > 0)
  const carry = anyCarry ? norm(members.map(m => m.carryWeight)) : own

  const paidIn = row.paid_in_capital ?? 0
  const dist = row.distributions
  const nav = row.nav
  const d = dist ?? 0
  const n = nav ?? 0
  const total = d + n
  const hasFund = row.tvpi != null && row.dpi != null
  const statedCarry = row.carried_interest != null ? Math.max(0, row.carried_interest) : null
  // The capital part of the row's total value, never more than the row holds.
  const capital = statedCarry != null
    ? Math.min(total, Math.max(0, total - statedCarry))
    : hasFund ? Math.min(total, Math.max(0, paidIn * (row.tvpi as number))) : total
  // Of which distributed: at the fund's LP DPI, or in the row's own proportion without it.
  let capDist = hasFund
    ? Math.min(d, capital, Math.max(0, paidIn * (row.dpi as number)))
    : total > 0 ? d * (capital / total) : 0
  // The rest is NAV; what NAV can't hold was distributed.
  const capNav = Math.min(n, capital - capDist)
  capDist = capital - capNav

  const shares = members.map((m, i) => ({
    entity_id: m.lpEntityId,
    commitment: round2(row.commitment * own[i]),
    paid_in_capital: row.paid_in_capital == null ? null : round2(paidIn * own[i]),
    distributions: dist == null ? null : round2(capDist * own[i] + (dist - capDist) * carry[i]),
    nav: nav == null ? null : round2(capNav * own[i] + (nav - capNav) * carry[i]),
  }))
  // Put any rounding cent on the largest share so the members add back to the row exactly.
  for (const k of ['commitment', 'paid_in_capital', 'distributions', 'nav'] as const) {
    const total = (row as any)[k === 'paid_in_capital' ? 'paid_in_capital' : k] as number | null
    if (total == null) continue
    const drift = round2(total - shares.reduce((a, s) => a + ((s[k] as number | null) ?? 0), 0))
    if (drift === 0) continue
    const big = shares.reduce((a, b) => (Math.abs((b[k] as number) ?? 0) > Math.abs((a[k] as number) ?? 0) ? b : a))
    ;(big as any)[k] = round2(((big[k] as number) ?? 0) + drift)
  }
  return shares
}
