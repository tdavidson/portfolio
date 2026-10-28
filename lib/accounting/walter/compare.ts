// Compare an engine's result with a vector's expected answer. Only what the vector states is
// checked: a vector about fees says nothing about allocations, and vice versa.

export interface Vector {
  id: string
  walter: string
  title: string
  description: string
  tags: string[]
  provenance: string
  terms: unknown
  flows: unknown[]
  expected: Expected
  tolerance?: string
}

export interface Expected {
  allocations?: { date: string; tier: string; partner: string; amount: string }[]
  totals?: Record<string, string>
  clawback?: { amount: string; entitlement?: string; cap?: string; fromEscrow?: string } | null
  accruedCarry?: { date: string; entitlement: string; byPartner?: Record<string, string> }[]
  fees?: {
    start: string
    gross: string
    offset: string
    net: string
    recognized?: Record<string, string>
    unapplied?: string
    byPartner?: Record<string, string>
  }[]
  carry?: { date: string; partner: string; amount: string }[]
  escrow?: { date: string; partner: string; amount: string }[]
  feesByPartner?: Record<string, string>
  recontributions?: { date: string; partner: string; amount: string }[]
  error?: string
}

export interface Outcome {
  status: 'pass' | 'fail' | 'unsupported'
  problems: string[]
}

// Amounts in vectors have at most a few decimal places, so comparing in cents as numbers is exact
// enough for a pass/fail check; the engines themselves must not use floats.
const n = (s: string | undefined) => (s === undefined ? 0 : Number(s))

type Row = { date: string; tier: string; partner: string; amount: string }
/** Every key of `want` and of `got`, compared: a key the engine reports that isn't listed must be zero. */
const bothWays = (label: string, want: Record<string, string>, got: Record<string, string> | undefined, near: (l: string, w?: string, g?: string) => void) => {
  for (const k of new Set([...Object.keys(want), ...Object.keys(got ?? {})])) near(`${label} ${k}`, want[k], got?.[k])
}

const aggregate = (rows: Row[]) => {
  const m = new Map<string, number>()
  for (const r of rows) {
    const k = `${r.date} ${r.tier} ${r.partner}`
    m.set(k, (m.get(k) ?? 0) + n(r.amount))
  }
  return m
}

export function compare(v: Vector, run: () => any): Outcome {
  const tol = n(v.tolerance ?? '0.01') + 1e-9
  const problems: string[] = []
  const e = v.expected
  let res: any
  try {
    res = run()
  } catch (err: any) {
    const code = err?.code
    if (code === 'unsupported') return { status: 'unsupported', problems: [String(err.message ?? 'unsupported')] }
    if (e.error && code === e.error) return { status: 'pass', problems: [] }
    return { status: 'fail', problems: [e.error ? `expected refusal ${e.error}, got ${code ?? err}` : `threw ${code ?? err}`] }
  }
  if (e.error) return { status: 'fail', problems: [`expected refusal ${e.error}, got a result`] }

  const near = (label: string, want: string | undefined, got: string | undefined) => {
    if (Math.abs(n(want) - n(got)) > tol) problems.push(`${label}: expected ${want ?? 0}, got ${got ?? 'nothing'}`)
  }
  if (e.allocations) {
    const want = aggregate(e.allocations)
    const got = aggregate(res.allocations ?? [])
    for (const k of new Set([...want.keys(), ...got.keys()])) {
      const w = want.get(k) ?? 0
      const g = got.get(k) ?? 0
      if (Math.abs(w - g) > tol) problems.push(`${k}: expected ${w.toFixed(2)}, got ${g.toFixed(2)}`)
    }
  }
  if (e.totals) for (const [p, a] of Object.entries(e.totals)) near(`total to ${p}`, a, res.totals?.[p]?.distributed)
  if (e.clawback === null && res.clawback && n(res.clawback.amount) !== 0) problems.push('expected no clawback')
  if (e.clawback) {
    near('clawback', e.clawback.amount, res.clawback?.amount)
    if (e.clawback.entitlement !== undefined) near('clawback entitlement', e.clawback.entitlement, res.clawback?.entitlement)
    if (e.clawback.cap !== undefined) near('clawback cap', e.clawback.cap, res.clawback?.cap)
    if (e.clawback.fromEscrow !== undefined) near('clawback from escrow', e.clawback.fromEscrow, res.clawback?.fromEscrow)
  }
  for (const a of e.accruedCarry ?? []) {
    const g = (res.accruedCarry ?? []).find((x: any) => x.date === a.date)
    near(`carry entitlement at ${a.date}`, a.entitlement, g?.entitlement)
    if (a.byPartner) bothWays(`carry accrued at ${a.date} by`, a.byPartner, g?.byPartner, near)
  }
  if (e.fees) {
    const got = res.fees ?? []
    if (got.length !== e.fees.length) problems.push(`fee periods: expected ${e.fees.length}, got ${got.length}`)
    for (const f of e.fees) {
      const g = got.find((x: any) => x.start === f.start)
      for (const k of ['gross', 'offset', 'net'] as const) near(`fee ${k} from ${f.start}`, f[k], g?.[k])
      if (f.recognized) {
        const got: Record<string, string> = g?.recognized ?? {}
        for (const k of new Set([...Object.keys(f.recognized), ...Object.keys(got)])) {
          near(`offset recognized from ${k} from ${f.start}`, f.recognized[k], got[k])
        }
      }
      if (f.unapplied !== undefined) near(`unapplied offset after ${f.start}`, f.unapplied, g?.unapplied)
      if (f.byPartner) bothWays(`fee from ${f.start} paid by`, f.byPartner, g?.byPartner, near)
    }
  }
  for (const [p, a] of Object.entries(e.feesByPartner ?? {})) near(`fee paid by ${p}`, a, res.feesByPartner?.[p])
  if (e.carry) {
    const want = aggregate(e.carry.map((r) => ({ ...r, tier: 'carry' })))
    const got = aggregate((res.carry ?? []).map((r: any) => ({ ...r, tier: 'carry' })))
    for (const k of new Set([...want.keys(), ...got.keys()])) near(k, String(want.get(k) ?? 0), String(got.get(k) ?? 0))
  }
  if (e.escrow) {
    const want = aggregate(e.escrow.map((r) => ({ ...r, tier: 'escrow' })))
    const got = aggregate((res.escrow ?? []).map((r: any) => ({ ...r, tier: 'escrow' })))
    for (const k of new Set([...want.keys(), ...got.keys()])) near(k, String(want.get(k) ?? 0), String(got.get(k) ?? 0))
  }
  if (e.recontributions) {
    const want = aggregate(e.recontributions.map((r) => ({ ...r, tier: 'recontribution' })))
    const got = aggregate((res.recontributions ?? []).map((r: any) => ({ ...r, tier: 'recontribution' })))
    for (const k of new Set([...want.keys(), ...got.keys()])) near(k, String(want.get(k) ?? 0), String(got.get(k) ?? 0))
  }
  return { status: problems.length ? 'fail' : 'pass', problems }
}
