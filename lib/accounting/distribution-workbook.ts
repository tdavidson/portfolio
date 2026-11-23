// A distribution's calculation as a workbook a person (or an auditor, or an assistant) can check
// line by line: the terms it ran on, where the waterfall stood before and after, each tier, and each
// partner's line broken into return of capital, preferred return, profit and carried interest.
//
// Two sources, one layout. From a PREVIEW (before declaring) it carries the replayed state and the
// checks; from a DECLARED distribution it carries the frozen register lines, the character, the
// deductions, what has been paid, and the reviewer's sign-off. Numbers are real numeric cells with
// an accounting format, so the file sums and pivots without re-keying.

import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DraftChecks } from '@/lib/drafting/checks'
import type { WaterfallTiers } from './distribution-waterfall'
import type { DistributionPreview } from './distributions'
import { roundCents } from './ledger'

const NUM = '#,##0.00;(#,##0.00)'
const PCT = '0.00%'

export const DISTRIBUTION_XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface DistributionCalcLine {
  name: string
  role: 'lp' | 'carry'
  amount: number
  returnOfCapital: number | null
  preferred: number | null
  profit: number | null
  deductions?: number
  paid?: number
}

export interface DistributionCalc {
  fundName: string
  vehicle: string
  source: 'preview' | 'declared'
  date: string
  description: string | null
  total: number
  method: 'waterfall' | 'pro_rata' | 'manual'
  terms: { kind: string; carryRate: number; prefRate: number; prefBase: string; recipients: string[] } | null
  tiers: WaterfallTiers | null
  stateBefore?: Record<string, number> | null
  stateAfter?: Record<string, number> | null
  character?: { returnOfCapital: number; realizedGain: number; income: number } | null
  lines: DistributionCalcLine[]
  warnings: string[]
  checks?: DraftChecks | null
  signOff?: { by: string | null; at: string; note: string | null } | null
  generatedAt: string
}

type Cell = string | number | null
interface FmtCell { v: number; z: string }
type Row = (Cell | FmtCell)[]
const isFmt = (c: Cell | FmtCell): c is FmtCell => typeof c === 'object' && c !== null && 'z' in c
const money = (v: number | null | undefined): Cell | FmtCell => (v == null || !Number.isFinite(v) ? null : { v: roundCents(v), z: NUM })
const pct = (v: number | null | undefined): Cell | FmtCell => (v == null || !Number.isFinite(v) ? null : { v, z: PCT })

function sheet(rows: Row[], widths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(c => (isFmt(c) ? c.v : c))))
  rows.forEach((row, ri) => row.forEach((c, ci) => {
    if (!isFmt(c)) return
    const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })]
    if (cell) { cell.t = 'n'; cell.z = c.z }
  }))
  ws['!cols'] = widths.map(wch => ({ wch }))
  return ws
}

const METHOD: Record<DistributionCalc['method'], string> = {
  waterfall: 'Waterfall (per the vehicle’s carry terms)',
  pro_rata: 'Pro-rata by capital balance',
  manual: 'Manual split (typed or edited)',
}

const STATE_LABEL: Record<string, string> = {
  contributedCapital: 'LP capital contributed',
  returnedCapital: 'Capital returned to LPs',
  preferredTarget: 'Preferred return accrued',
  preferredPaid: 'Preferred return paid',
  gpCatchUpPaid: 'GP catch-up paid',
  gpCarryPaid: 'Carried interest paid',
}

/** The workbook, as bytes. Pure. */
export function buildDistributionWorkbook(c: DistributionCalc): Buffer {
  const wb = XLSX.utils.book_new()

  const summary: Row[] = [
    [c.fundName],
    [`Distribution calculation — ${c.vehicle}`],
    [],
    ['Status', c.source === 'preview' ? 'Preview — not declared' : 'Declared'],
    ['Distribution date', c.date],
    ['Description', c.description ?? ''],
    ['Total distributed', money(c.total)],
    ['Split', METHOD[c.method]],
  ]
  if (c.terms) {
    summary.push([], ['Terms'])
    summary.push(['Waterfall', c.terms.kind])
    summary.push(['Carry rate', pct(c.terms.carryRate)])
    summary.push(['Preferred return rate', pct(c.terms.prefRate)])
    summary.push(['Preferred return base', c.terms.prefBase])
    summary.push(['Carry recipients', c.terms.recipients.join(', ')])
  }
  if (c.tiers) {
    const t = c.tiers
    summary.push([], ['Tiers', 'Amount'])
    summary.push(['Return of capital to LPs', money(t.returnOfCapital)])
    summary.push(['Preferred return to LPs', money(t.preferred)])
    summary.push(['GP catch-up', money(t.catchUp)])
    if ((t.catchUpToLP ?? 0) > 0) summary.push(['LPs’ share of the catch-up tier', money(t.catchUpToLP ?? 0)])
    summary.push(['Profit to LPs (final split)', money(t.profitToLP)])
    summary.push(['Carried interest (final split)', money(t.carry)])
    if ((t.carryFree ?? 0) > 0) {
      summary.push(['GP’s own capital, outside the tiers', money(t.carryFree ?? 0)])
      summary.push(['  of which return of GP capital', money(t.carryFreeCapital ?? 0)])
    }
    summary.push(['Total to LPs (tiers)', money(t.toLP)])
    summary.push(['Total to GP (catch-up and carry)', money(t.toGP)])
  }
  if (c.character) {
    summary.push([], ['Tax character (K-1)', 'Amount'])
    summary.push(['Return of capital', money(c.character.returnOfCapital)])
    summary.push(['Realized gain', money(c.character.realizedGain)])
    summary.push(['Income', money(c.character.income)])
  }
  if (c.signOff) {
    summary.push([], ['Reviewed by', c.signOff.by ?? ''], ['Reviewed at', c.signOff.at], ['Review note', c.signOff.note ?? ''])
  } else if (c.source === 'declared') {
    summary.push([], ['Reviewed by', 'Not yet reviewed'])
  }
  summary.push([], ['Generated', c.generatedAt])
  XLSX.utils.book_append_sheet(wb, sheet(summary, [42, 34]), 'Summary')

  const hasPaid = c.lines.some(l => l.paid != null)
  const header: Row = ['Partner', 'Line', 'Amount', 'Return of capital', 'Preferred return', 'Profit', 'Carried interest', 'Deductions', 'Net payable', ...(hasPaid ? ['Paid'] : [])]
  const lineRows: Row[] = [header]
  const sorted = [...c.lines].sort((a, b) => a.name.localeCompare(b.name) || (a.role === 'lp' ? -1 : 1))
  for (const l of sorted) {
    const isCarry = l.role === 'carry'
    lineRows.push([
      l.name,
      isCarry ? 'Carried interest' : 'Distribution on capital',
      money(l.amount),
      isCarry ? null : money(l.returnOfCapital),
      isCarry ? null : money(l.preferred),
      isCarry ? null : money(l.profit),
      isCarry ? money(l.amount) : null,
      money(l.deductions ?? 0),
      money(roundCents(l.amount - (l.deductions ?? 0))),
      ...(hasPaid ? [money(l.paid ?? 0)] : []),
    ])
  }
  const sum = (f: (l: DistributionCalcLine) => number | null) => roundCents(c.lines.reduce((s, l) => s + (f(l) ?? 0), 0))
  lineRows.push([
    'Total', '',
    money(sum(l => l.amount)),
    money(sum(l => (l.role === 'lp' ? l.returnOfCapital : 0))),
    money(sum(l => (l.role === 'lp' ? l.preferred : 0))),
    money(sum(l => (l.role === 'lp' ? l.profit : 0))),
    money(sum(l => (l.role === 'carry' ? l.amount : 0))),
    money(sum(l => l.deductions ?? 0)),
    money(sum(l => l.amount - (l.deductions ?? 0))),
    ...(hasPaid ? [money(sum(l => l.paid ?? 0))] : []),
  ])
  if (c.lines.some(l => l.role === 'lp' && l.returnOfCapital == null)) {
    lineRows.push([], ['Lines with no breakdown were declared without the waterfall (pro-rata, typed, or before breakdowns were stored).'])
  }
  XLSX.utils.book_append_sheet(wb, sheet(lineRows, [34, 22, 14, 16, 16, 14, 16, 12, 14, 12]), 'Partner lines')

  if (c.stateBefore || c.stateAfter) {
    const keys = Array.from(new Set([...Object.keys(c.stateBefore ?? {}), ...Object.keys(c.stateAfter ?? {})]))
    const rows: Row[] = [['Waterfall position', 'Before', 'This distribution', 'After']]
    for (const k of keys) {
      const before = c.stateBefore?.[k] ?? null
      const after = c.stateAfter?.[k] ?? null
      rows.push([STATE_LABEL[k] ?? k, money(before), money(before != null && after != null ? after - before : null), money(after)])
    }
    XLSX.utils.book_append_sheet(wb, sheet(rows, [32, 16, 18, 16]), 'Waterfall position')
  }

  const notes: Row[] = [['Checks and warnings', 'Severity']]
  for (const m of c.checks?.missing ?? []) notes.push([`${m.label}: ${m.why}`, m.required ? 'Missing (required)' : 'Missing'])
  for (const f of c.checks?.flags ?? []) notes.push([f.message, f.severity])
  const flagged = new Set((c.checks?.flags ?? []).map(f => f.message))
  for (const w of c.warnings) if (!flagged.has(w)) notes.push([w, 'warning'])
  if (notes.length === 1) notes.push(['None.', ''])
  XLSX.utils.book_append_sheet(wb, sheet(notes, [110, 18]), 'Checks')

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

/** A preview (writing nothing) as a calc. */
export function calcFromPreview(
  preview: DistributionPreview,
  meta: { fundName: string; vehicle: string; date: string; description?: string | null; total: number; checks?: DraftChecks | null; generatedAt: string },
): DistributionCalc {
  const breakdown = new Map((preview.lineBreakdown ?? []).map(b => [b.lpEntityId, b]))
  const nameOf = (id: string) => preview.names[id] ?? id
  return {
    fundName: meta.fundName,
    vehicle: meta.vehicle,
    source: 'preview',
    date: meta.date,
    description: meta.description ?? null,
    total: meta.total,
    method: preview.method,
    terms: preview.terms,
    tiers: preview.method === 'waterfall' ? preview.tiers : null,
    stateBefore: preview.stateBefore as unknown as Record<string, number>,
    stateAfter: preview.stateAfter as unknown as Record<string, number>,
    character: preview.suggestedCharacter,
    lines: [
      ...preview.lines.map(l => {
        const b = breakdown.get(l.lpEntityId)
        return { name: nameOf(l.lpEntityId), role: 'lp' as const, amount: l.amount, returnOfCapital: b?.returnOfCapital ?? null, preferred: b?.preferred ?? null, profit: b?.profit ?? null }
      }),
      ...preview.carryLines.map(l => ({ name: nameOf(l.lpEntityId), role: 'carry' as const, amount: l.amount, returnOfCapital: null, preferred: null, profit: null })),
    ],
    warnings: preview.warnings,
    checks: meta.checks ?? null,
    generatedAt: meta.generatedAt,
  }
}

/** A declared distribution, from its register, as a calc. */
export async function loadDeclaredCalc(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  distributionId: string,
  meta: { fundName: string; generatedAt: string; terms?: DistributionCalc['terms'] },
): Promise<DistributionCalc | null> {
  const { listDistributions } = await import('./distributions')
  const all = await listDistributions(admin, fundId, group)
  const d = all.find(x => x.distributionId === distributionId)
  if (!d) return null
  return {
    fundName: meta.fundName,
    vehicle: group,
    source: 'declared',
    date: d.date,
    description: d.description,
    total: d.total,
    method: d.splitMethod,
    terms: meta.terms ?? null,
    tiers: d.tiers,
    character: d.characterised ? d.character : null,
    lines: d.lines.map(l => ({
      name: l.name,
      role: l.role,
      amount: l.amount,
      returnOfCapital: l.breakdown?.returnOfCapital ?? null,
      preferred: l.breakdown?.preferred ?? null,
      profit: l.breakdown?.profit ?? null,
      deductions: roundCents((l.deductions ?? []).reduce((s, x) => s + x.amount, 0)),
      paid: l.settled,
    })),
    warnings: [],
    signOff: d.signOff ?? null,
    generatedAt: meta.generatedAt,
  }
}

export function distributionWorkbookFileName(fundName: string, vehicle: string, date: string, source: 'preview' | 'declared'): string {
  const clean = (s: string) => s.replace(/[^\w .,-]/g, '').trim()
  return `${clean(fundName || 'Fund')} - ${clean(vehicle)} - Distribution ${date}${source === 'preview' ? ' (preview)' : ''}.xlsx`
}
