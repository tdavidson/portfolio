// A package as a caller gives it (the app, the assistant over MCP, a CSV), normalised, or the first
// thing wrong with it. Accepts snake_case or camelCase field names, and amounts as numbers or as a
// statement prints them ("1,250.00", "(1,250.00)"). Pure.

import { MAX_POSITIONS, parseAmount } from '@/lib/admin-reporting/figures'
import {
  ALLOCATION_KEYS, CAPITAL_FIELDS,
  type Allocations, type CapitalFigures, type Citation, type FundStatements, type HoldingLine,
  type CashLine, type PackageDocument, type PartnerStatement, type StatedLine, type StatementPackage,
} from './types'

const ISO = /^\d{4}-\d{2}-\d{2}$/
export const isDate = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v))
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const snake = (k: string) => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
/** A field by its camelCase name or the snake_case one. */
const pick = (o: any, k: string): unknown => (o == null ? undefined : o[k] !== undefined ? o[k] : o[snake(k)])

const MAX_LINES = 500
const MAX_HOLDINGS = 2000

class Bad extends Error {}

function amount(o: any, k: string, at: string): number | undefined {
  const v = pick(o, k)
  const n = parseAmount(v)
  if (n === 'invalid') throw new Bad(`${at}: ${snake(k)} must be an amount`)
  return n == null ? undefined : n
}

function citation(v: any): Citation | undefined {
  const document = text(v?.document ?? v?.doc, 300)
  if (!document) return undefined
  const page = Number(v?.page)
  const label = text(v?.label, 300)
  return { document, ...(Number.isInteger(page) && page > 0 ? { page } : {}), ...(label ? { label } : {}) }
}

function citeMap(v: any): Record<string, Citation> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const out: Record<string, Citation> = {}
  for (const [k, c] of Object.entries(v).slice(0, 50)) {
    const cc = citation(c)
    // Field names in either case; stored camelCase so the checks find them.
    if (cc) out[k.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())] = cc
  }
  return Object.keys(out).length ? out : undefined
}

function allocations(o: any, at: string): Allocations | undefined {
  // Nested ({ allocations: { income } }) or flat on the row ({ income }); nested wins.
  const src = pick(o, 'allocations') && typeof pick(o, 'allocations') === 'object' ? pick(o, 'allocations') : o
  const out: Allocations = {}
  for (const k of [...ALLOCATION_KEYS, 'total'] as const) {
    const n = amount(src, k === 'total' && src === o ? 'netAllocation' : k, `${at}.allocations`)
    if (n != null) out[k] = n
  }
  return Object.keys(out).length ? out : undefined
}

function capital(o: any, at: string): CapitalFigures {
  const out: CapitalFigures = {}
  for (const k of CAPITAL_FIELDS) {
    const n = amount(o, k, at)
    if (n != null) (out as any)[k] = n
  }
  const a = allocations(o, at)
  if (a) out.allocations = a
  const c = citeMap(pick(o, 'cite'))
  if (c) out.cite = c
  return out
}

function lines(v: unknown, at: string): StatedLine[] | undefined {
  if (v == null) return undefined
  if (!Array.isArray(v)) throw new Bad(`${at} must be a list of { label, amount }`)
  if (v.length > MAX_LINES) throw new Bad(`${at}: at most ${MAX_LINES} lines`)
  return v.map((l: any, i) => {
    const label = text(l?.label, 300)
    if (!label) throw new Bad(`${at}[${i}]: label is required`)
    const n = amount(l, 'amount', `${at}[${i}]`)
    if (n == null) throw new Bad(`${at}[${i}]: amount is required`)
    const c = citation(l?.cite)
    return { label, amount: n, ...(c ? { cite: c } : {}) }
  })
}

function fundStatements(f: any): FundStatements | undefined {
  if (!f || typeof f !== 'object') return undefined
  const out: FundStatements = {}
  const bsIn = pick(f, 'balanceSheet') as any
  if (bsIn && typeof bsIn === 'object') {
    const bs: NonNullable<FundStatements['balanceSheet']> = {}
    const assets = lines(pick(bsIn, 'assets'), 'fund.balance_sheet.assets')
    const liabilities = lines(pick(bsIn, 'liabilities'), 'fund.balance_sheet.liabilities')
    if (assets) bs.assets = assets
    if (liabilities) bs.liabilities = liabilities
    for (const k of ['totalAssets', 'totalLiabilities', 'partnersCapital', 'totalLiabilitiesAndCapital'] as const) {
      const n = amount(bsIn, k, 'fund.balance_sheet')
      if (n != null) bs[k] = n
    }
    const c = citeMap(pick(bsIn, 'cite'))
    if (c) bs.cite = c
    if (Object.keys(bs).length) out.balanceSheet = bs
  }
  const opsIn = pick(f, 'operations') as any
  if (opsIn && typeof opsIn === 'object') {
    const ops: NonNullable<FundStatements['operations']> = {}
    const l = lines(pick(opsIn, 'lines'), 'fund.operations.lines')
    if (l) ops.lines = l
    const n = amount(opsIn, 'netIncome', 'fund.operations')
    if (n != null) ops.netIncome = n
    const c = citeMap(pick(opsIn, 'cite'))
    if (c) ops.cite = c
    if (Object.keys(ops).length) out.operations = ops
  }
  for (const k of ['partnersCapital', 'partnerTotals'] as const) {
    const v = pick(f, k)
    if (v && typeof v === 'object') {
      const c = capital(v, `fund.${snake(k)}`)
      if (Object.keys(c).length) out[k] = c
    }
  }
  const soiIn = pick(f, 'soi') as any
  if (soiIn && typeof soiIn === 'object') {
    const soi: NonNullable<FundStatements['soi']> = {}
    for (const k of ['cost', 'fairValue'] as const) {
      const n = amount(soiIn, k, 'fund.soi')
      if (n != null) soi[k] = n
    }
    const c = citeMap(pick(soiIn, 'cite'))
    if (c) soi.cite = c
    if (Object.keys(soi).length) out.soi = soi
  }
  return Object.keys(out).length ? out : undefined
}

function partners(v: unknown): PartnerStatement[] | undefined {
  if (v == null) return undefined
  if (!Array.isArray(v)) throw new Bad('partners must be a list, one entry per capital account')
  if (v.length > MAX_POSITIONS) throw new Bad(`At most ${MAX_POSITIONS} partners in one package.`)
  const seen = new Set<string>()
  return v.map((p: any, i) => {
    const at = `partners[${i}]`
    const name = text(p?.name, 300)
    if (!name) throw new Bad(`${at}: name is required`)
    const externalId = text(pick(p, 'externalId'), 200) ?? name
    if (seen.has(externalId)) throw new Bad(`${at}: ${name} is given twice`)
    seen.add(externalId)
    const lpEntityId = text(pick(p, 'lpEntityId'), 64)
    return { externalId, name, ...(lpEntityId ? { lpEntityId } : {}), ...capital(p, at) }
  })
}

function holdings(v: unknown): HoldingLine[] | undefined {
  if (v == null) return undefined
  if (!Array.isArray(v)) throw new Bad('holdings must be a list')
  if (v.length > MAX_HOLDINGS) throw new Bad(`At most ${MAX_HOLDINGS} holdings in one package.`)
  return v.map((h: any, i) => {
    const name = text(h?.name, 300)
    if (!name) throw new Bad(`holdings[${i}]: name is required`)
    const cost = amount(h, 'cost', `holdings[${i}]`)
    const fairValue = amount(h, 'fairValue', `holdings[${i}]`)
    const c = citation(h?.cite)
    return { name, ...(cost != null ? { cost } : {}), ...(fairValue != null ? { fairValue } : {}), ...(c ? { cite: c } : {}) }
  })
}

function cashLines(v: unknown): CashLine[] | undefined {
  if (v == null) return undefined
  if (!Array.isArray(v)) throw new Bad('cash must be a list of { account, balance }')
  if (v.length > MAX_LINES) throw new Bad(`cash: at most ${MAX_LINES} lines`)
  return v.map((c: any, i) => {
    const account = text(c?.account ?? c?.label, 300)
    if (!account) throw new Bad(`cash[${i}]: account is required`)
    const balance = amount(c, 'balance', `cash[${i}]`) ?? amount(c, 'amount', `cash[${i}]`)
    if (balance == null) throw new Bad(`cash[${i}]: balance is required`)
    const cc = citation(c?.cite)
    return { account, balance, ...(cc ? { cite: cc } : {}) }
  })
}

function documents(v: unknown): PackageDocument[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, 100).flatMap((d: any) => {
    const name = text(d?.name, 300)
    if (!name) return []
    const hash = typeof d?.hash === 'string' && /^[0-9a-f]{64}$/i.test(d.hash) ? d.hash.toLowerCase() : undefined
    const kind = text(d?.kind, 50)
    const pages = Number(d?.pages)
    return [{ name, ...(hash ? { hash } : {}), ...(kind ? { kind } : {}), ...(Number.isInteger(pages) && pages > 0 ? { pages } : {}) }]
  })
}

/** The first day of the quarter a date falls in. */
export function quarterStart(date: string): string {
  const [y, m] = date.split('-').map(Number)
  const qm = Math.floor((m - 1) / 3) * 3 + 1
  return `${y}-${String(qm).padStart(2, '0')}-01`
}

export function cleanPackage(input: any, vehicleId: string): StatementPackage | string {
  if (!input || typeof input !== 'object') return 'package is required'
  const periodEnd = pick(input, 'periodEnd') ?? pick(input, 'asOf')
  if (!isDate(periodEnd)) return 'period_end must be a date (YYYY-MM-DD)'
  const rawStart = pick(input, 'periodStart')
  if (rawStart != null && !isDate(rawStart)) return 'period_start must be a date (YYYY-MM-DD)'
  const periodStart = (rawStart as string | undefined) ?? quarterStart(periodEnd)
  if (periodStart > periodEnd) return 'period_start must be on or before period_end'
  const source = pick(input, 'source') ?? 'administrator'
  if (source !== 'administrator' && source !== 'books') return "source must be 'administrator' or 'books'"
  try {
    const pkg: StatementPackage = { vehicleId, periodStart, periodEnd, source, documents: documents(pick(input, 'documents')) }
    const p = partners(pick(input, 'partners'))
    const f = fundStatements(pick(input, 'fund'))
    const h = holdings(pick(input, 'holdings'))
    const c = cashLines(pick(input, 'cash'))
    if (p) pkg.partners = p
    if (f) pkg.fund = f
    if (h) pkg.holdings = h
    if (c) pkg.cash = c
    if (!p?.length && !f && !h?.length && !c?.length) return 'The package has nothing to check: give partners, fund statements, holdings or cash.'
    return pkg
  } catch (e) {
    if (e instanceof Bad) return e.message
    throw e
  }
}
