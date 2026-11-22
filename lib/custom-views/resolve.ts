// Turn a view spec into figures, as the person opening it.
//
// Every data block is answered the way the assistant's own query tool would answer it
// (lib/agent/query-tools.ts): the tool's access, the dataset's gate, the same scoped loader, the
// same engine. Nothing here reads the database directly, so a view can only ever lay out what
// its viewer could already ask for. A block the viewer may not read is returned `denied` with no
// rows, never an error page: one shared view serves colleagues with different access.
//
// Blocks over the same dataset share one load (the LP live report is the slow one), and every
// block loads in parallel.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { hasAccess } from '@/lib/access/effective'
import { DOMAIN_META } from '@/lib/access/domains'
import { entityScopeFor } from '@/lib/access/entity-scope'
import {
  accessDomainForCall, accessFeatureFor, getTool, resolveVehicleForTool,
  type AgentToolContext,
} from '@/lib/accounting/agent-tools'
import { listVehicles } from '@/lib/accounting/load'
import { VehicleResolutionError } from '@/lib/accounting/vehicle-resolver'
import { QUERY_LOADERS, type DatasetParams } from '@/lib/agent/query/datasets'
import { runQuery } from '@/lib/agent/query/engine'
import { loadBranding } from '@/lib/mcp-apps/branding'
import type { CustomBlock, CustomValueFormat, CustomViewPayload, DashboardBranding } from '@/lib/mcp-apps/payload'
import {
  cleanFilterValues, cleanParams, findDataset, isDataBlock, isFormulaBlock, MAX_SERIES, splitQuery,
  type BlockSource, type ChartBlock, type ComparePeriod, type DataBlock, type FilterValue, type FormulaKpiBlock, type PivotBlock, type TableBlock,
  type ViewBlock, type ViewFilter, type ViewParam, type ViewSpec,
} from './spec'
import { applyComputed, evaluate, parseFormula } from './formula'
import type { Column, Filter, QueryResult } from '@/lib/agent/query/engine'

type Row = Record<string, unknown>
type Loader = (ctx: AgentToolContext, params: DatasetParams) => Promise<Row[]>

export interface ResolveDeps {
  admin: SupabaseClient
  fundId: string
  userId: string | null
  access: AccessContext
  /** Tests swap the loaders and the branding/vehicle lookups. */
  loaders?: Record<string, Loader>
  branding?: () => Promise<DashboardBranding>
  vehicles?: () => Promise<string[]>
}

export interface ViewRef {
  id: string | null
  name?: string
  url?: string | null
}

/** Points per chart, after the query's own limit. More than this is not a chart anyone reads. */
export const MAX_CHART_POINTS = 60
/** Dots per scatter: a scatter is read as a cloud, so it can carry more. */
export const MAX_SCATTER_POINTS = 500

/**
 * Long rows (one per x and series) as one point per x with a figure per series. Series are ordered
 * by their total size, largest first; past MAX_SERIES the smallest are summed as "Other". Points
 * keep the order the query returned their first row in, so the query's sort still decides it.
 */
export function pivotSeries(rows: Row[], x: string, y: string, seriesColumn: string): { points: { label: string; value: number; values: number[] }[]; series: string[] } {
  const byLabel = new Map<string, Map<string, number>>()
  const totals = new Map<string, number>()
  for (const r of rows) {
    const v = Number(r[y])
    if (!Number.isFinite(v)) continue
    const label = String(cell(r[x]) ?? '—')
    const name = String(cell(r[seriesColumn]) ?? '—')
    if (!byLabel.has(label)) {
      if (byLabel.size >= MAX_CHART_POINTS) continue
      byLabel.set(label, new Map())
    }
    const m = byLabel.get(label)!
    m.set(name, (m.get(name) ?? 0) + v)
    totals.set(name, (totals.get(name) ?? 0) + Math.abs(v))
  }
  const ranked = Array.from(totals.keys()).sort((a, b) => totals.get(b)! - totals.get(a)!)
  const kept = ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked
  const folded = ranked.length > MAX_SERIES
  const series = folded ? [...kept, 'Other'] : kept
  const points = Array.from(byLabel.entries()).map(([label, m]) => {
    const values = kept.map(name => m.get(name) ?? 0)
    if (folded) values.push(ranked.slice(MAX_SERIES - 1).reduce((sum, name) => sum + (m.get(name) ?? 0), 0))
    return { label, value: values.reduce((a, b) => a + b, 0), values }
  })
  return { points, series }
}

const cell = (v: unknown): string | number | null => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) return v.map(String).join(', ')
  return String(v)
}

const humanize = (column: string) => {
  const t = column.replace(/_/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : column
}

/** A sensible default format for a table column the spec left unformatted. */
function guessFormat(column: string, sample: unknown): CustomValueFormat {
  if (/(^|_)(dpi|rvpi|tvpi|moic)$/.test(column)) return 'multiple'
  if (/(pct|percent|irr)/.test(column)) return 'percent'
  if (/(^|_)(date|as_of|created_at)$/.test(column) || /_date$/.test(column)) return 'date'
  if (typeof sample === 'number') {
    return /(count|shares|quarter|year|month|days)/.test(column) ? 'number' : 'currency'
  }
  return 'text'
}

/** The filters a block can take: only those on a column its dataset has. */
function filterClauses(meta: { columns: Column[] }, filters: ViewFilter[], values: Record<string, FilterValue>): Filter[] {
  const out: Filter[] = []
  for (const f of filters) {
    const v = values[f.column]
    const col = meta.columns.find(c => c.name === f.column)
    if (!v || !col) continue
    if (f.kind === 'pick' && v.pick !== undefined) {
      out.push({ column: f.column, op: 'eq', value: col.type === 'boolean' ? v.pick === 'Yes' || v.pick === 'true' : v.pick })
    } else if (f.kind === 'range') {
      const read = (x: string) => (col.type === 'number' ? Number(x) : x)
      if (v.from !== undefined && (col.type !== 'number' || Number.isFinite(Number(v.from)))) out.push({ column: f.column, op: 'gte', value: read(v.from) })
      if (v.to !== undefined && (col.type !== 'number' || Number.isFinite(Number(v.to)))) out.push({ column: f.column, op: 'lte', value: read(v.to) })
    }
  }
  return out
}

/** The block's query over loaded rows: filters, the engine, calculated columns, then their sort. */
function runSource(block: { source: BlockSource }, meta: { columns: Column[] }, rows: Row[], where: Filter[]): QueryResult {
  const { engine, post, limit } = splitQuery(block.source)
  const result = runQuery(rows, meta.columns, { ...engine, where: [...(engine.where ?? []), ...where] })
  const computed = block.source.computed ?? []
  if (!computed.length) return result
  let out = applyComputed(result.rows, computed, result.columns)
  if (post.length) {
    const cmp = (a: unknown, b: unknown) => {
      if (a == null && b == null) return 0
      if (a == null) return 1
      if (b == null) return -1
      return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
    }
    out = out.slice().sort((x, y) => {
      for (const o of post) {
        const d = cmp(x[o.column], y[o.column]) * (o.direction === 'desc' ? -1 : 1)
        if (d) return d
      }
      return 0
    })
    if (limit) out = out.slice(0, limit)
  }
  return { ...result, rows: out, columns: [...result.columns, ...computed.map(c => c.as)] }
}

const ISO = (d: Date) => d.toISOString().slice(0, 10)

/** The same date `months` earlier; a month end stays a month end (Sep 30 → Jun 30). */
export function shiftDate(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  const isMonthEnd = d.getUTCDate() === lastOfMonth
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1))
  const targetLast = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(isMonthEnd ? targetLast : Math.min(d.getUTCDate(), targetLast))
  return ISO(target)
}

const COMPARE_MONTHS: Record<ComparePeriod, number> = { prior_month: 1, prior_quarter: 3, prior_year: 12 }

interface LoadContext {
  values: Partial<Record<ViewParam, string>>
  filters: ViewFilter[]
  filterValues: Record<string, FilterValue>
  /** Pick-list options per filter column, gathered from the rows the blocks loaded. */
  options: Map<string, Set<string>>
  cache: Map<string, Promise<Row[]>>
  today: string
  /** Set when a block could not load without one entity named (a ledger dataset in a fund with several). */
  needsVehicle?: boolean
}

async function loadBlock(deps: ResolveDeps, block: DataBlock, lc: LoadContext): Promise<CustomBlock> {
  const { values, cache } = lc
  const base = { id: block.id, type: block.type, label: block.label, span: block.span }
  const { tool: toolName, dataset } = block.source
  const tool = getTool(toolName)
  const meta = findDataset(toolName, dataset)
  if (!tool || !meta) return { ...base, status: 'error', message: `${toolName} ${dataset} is no longer available.` }

  const input = { dataset, ...(values.vehicle ? { vehicle: values.vehicle } : {}), ...(values.as_of ? { as_of: values.as_of } : {}) }
  // The tool's own gate (as the assistant's call would be checked) and the dataset's (as the
  // query handler checks it): a block can never show more than either would.
  const toolDomain = accessDomainForCall(tool, input)
  if (!hasAccess(deps.access, toolDomain, 'read', accessFeatureFor(tool))) {
    return { ...base, status: 'denied', message: `Needs access to ${DOMAIN_META[toolDomain].label}.` }
  }
  if (!hasAccess(deps.access, meta.gate.domain, 'read', meta.gate.feature)) {
    return { ...base, status: 'denied', message: `Needs access to ${DOMAIN_META[meta.gate.domain].label}.` }
  }

  try {
    // Ledger datasets work on one entity; resolving it checks the viewer may see that entity.
    const portfolioGroup = await resolveVehicleForTool(tool, deps.admin, deps.fundId, values.vehicle, deps.access)
    const loader = (deps.loaders ?? QUERY_LOADERS)[dataset]
    if (!loader) return { ...base, status: 'error', message: `${dataset} has no loader.` }
    const load = (asOf: string | undefined) => {
      const key = JSON.stringify([dataset, portfolioGroup, values.vehicle ?? null, asOf ?? null])
      let rows = cache.get(key)
      if (!rows) {
        const ctx: AgentToolContext = { admin: deps.admin, fundId: deps.fundId, portfolioGroup, userId: deps.userId, access: deps.access }
        rows = loader(ctx, { vehicle: values.vehicle, as_of: asOf })
        cache.set(key, rows)
      }
      return rows
    }
    const loaded = await load(values.as_of)
    // Pick lists offer the values this viewer's rows hold, before any filter narrows them.
    for (const f of lc.filters) {
      if (f.kind !== 'pick' || !meta.columns.some(c => c.name === f.column)) continue
      const set = lc.options.get(f.column) ?? new Set<string>()
      for (const r of loaded) {
        const v = r[f.column]
        for (const item of Array.isArray(v) ? v : [v]) {
          if (item === null || item === undefined || item === '' || set.size >= 200) continue
          set.add(typeof item === 'boolean' ? (item ? 'Yes' : 'No') : String(item))
        }
      }
      lc.options.set(f.column, set)
    }
    const where = filterClauses(meta, lc.filters, lc.filterValues)
    const result = runSource(block, meta, loaded, where)

    if (block.type === 'kpi') {
      const first = result.rows[0]
      const out: CustomBlock = { ...base, status: 'ok', format: block.format, value: first ? cell(first[block.value]) : null, ...(block.sub ? { sub: block.sub } : {}) }
      if (block.compare) {
        const at = shiftDate(values.as_of ?? lc.today, COMPARE_MONTHS[block.compare])
        const prior = runSource(block, meta, await load(at), where).rows[0]
        const pv = prior ? Number(prior[block.value]) : NaN
        out.previous = Number.isFinite(pv) ? pv : null
        out.previousLabel = `vs ${new Date(`${at}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
      }
      if (block.trend) {
        const t = block.trend
        const tmeta = findDataset(t.source.tool, t.source.dataset)
        const tloader = tmeta && (deps.loaders ?? QUERY_LOADERS)[t.source.dataset]
        // Only a dataset under the same gate as the figure, so a sparkline never shows more than its tile.
        if (tmeta && tloader && hasAccess(deps.access, tmeta.gate.domain, 'read', tmeta.gate.feature)) {
          const key = JSON.stringify([t.source.dataset, portfolioGroup, values.vehicle ?? null, values.as_of ?? null])
          let trows = cache.get(key)
          if (!trows) {
            trows = tloader({ admin: deps.admin, fundId: deps.fundId, portfolioGroup, userId: deps.userId, access: deps.access }, { vehicle: values.vehicle, as_of: values.as_of })
            cache.set(key, trows)
          }
          const spark = runSource(t, tmeta, await trows, filterClauses(tmeta, lc.filters, lc.filterValues)).rows
            .map(r => ({ label: String(cell(r[t.x]) ?? ''), value: Number(r[t.y]) }))
            .filter(p => Number.isFinite(p.value))
            .slice(-MAX_CHART_POINTS)
          if (spark.length > 1) out.spark = spark
        }
      }
      return out
    }
    if (block.type === 'gauge') {
      const first = result.rows[0]
      const v = first ? Number(first[block.value]) : NaN
      const max = block.max_column ? Number(first?.[block.max_column]) : block.max
      return {
        ...base, status: 'ok', format: block.format,
        value: Number.isFinite(v) ? v : null,
        gaugeMax: max !== undefined && Number.isFinite(max) && max > 0 ? max : null,
        ...(block.target !== undefined ? { target: block.target } : {}),
      }
    }
    if (block.type === 'pivot' || block.type === 'heatmap') return pivotBlock(block as PivotBlock, base, result.rows)
    if (block.type !== 'table') return chartBlock(block as ChartBlock, base, result.rows)
    const table = block as TableBlock
    const columns = table.columns.map(c => ({
      key: c.column,
      label: c.label ?? humanize(c.column),
      format: c.format ?? guessFormat(c.column, result.rows.find(r => r[c.column] != null)?.[c.column]),
      ...(c.tone ? { tone: c.tone } : {}),
      ...(c.link ? { link: c.link } : {}),
    }))
    const summed = (f: CustomValueFormat) => f === 'currency' || f === 'number'
    // Subtotals keep the query's order within each group, groups in order of first appearance.
    let source = result.rows
    let subtotals: CustomBlock['subtotals']
    if (table.subtotal_by) {
      const by = table.subtotal_by
      const groups = new Map<string, Row[]>()
      for (const r of source) {
        const k = String(cell(r[by]) ?? '—')
        groups.set(k, [...(groups.get(k) ?? []), r])
      }
      source = Array.from(groups.values()).flat()
      subtotals = []
      let at = 0
      for (const [k, rs] of groups) {
        at += rs.length
        subtotals.push({
          after: at - 1,
          label: k,
          values: Object.fromEntries(columns.map(c => [c.key, summed(c.format) ? rs.reduce((t, r) => t + (Number.isFinite(Number(r[c.key])) && r[c.key] !== null ? Number(r[c.key]) : 0), 0) : null])),
        })
      }
    }
    const rows2 = source.map(r => Object.fromEntries(columns.map(c => [c.key, cell(r[c.key])])))
    const links = columns.some(c => c.link === 'company')
      ? source.map(r => Object.fromEntries(columns.filter(c => c.link === 'company' && r.company_id).map(c => [c.key, `company:${String(r.company_id)}`])))
      : undefined
    const totalsRow = table.totals
      ? Object.fromEntries(columns.map(c => [c.key, summed(c.format)
        ? rows2.reduce((s: number, r) => s + (typeof r[c.key] === 'number' ? (r[c.key] as number) : 0), 0)
        : null]))
      : undefined
    return {
      ...base, status: 'ok', columns, rows: rows2, truncated: result.truncated,
      ...(totalsRow ? { totalsRow } : {}), ...(subtotals ? { subtotals } : {}), ...(links ? { links } : {}),
    }
  } catch (e) {
    if (e instanceof VehicleResolutionError && !values.vehicle) lc.needsVehicle = true
    return { ...base, status: 'error', message: (e as Error).message || 'Could not load this block.' }
  }
}

/** Pivot columns past this are not a table anyone reads; rows are capped like a chart's. */
export const MAX_PIVOT_COLUMNS = 24

function pivotBlock(block: PivotBlock, base: Pick<CustomBlock, 'id' | 'type' | 'label' | 'span'>, rows: Row[]): CustomBlock {
  const rowKeys: string[] = []
  const colKeys: string[] = []
  const cells = new Map<string, number>()
  for (const r of rows) {
    const v = Number(r[block.value])
    if (!Number.isFinite(v)) continue
    const rk = String(cell(r[block.rows]) ?? '—')
    const ck = String(cell(r[block.columns]) ?? '—')
    if (!rowKeys.includes(rk)) { if (rowKeys.length >= MAX_CHART_POINTS * 3) continue; rowKeys.push(rk) }
    if (!colKeys.includes(ck)) { if (colKeys.length >= MAX_PIVOT_COLUMNS) continue; colKeys.push(ck) }
    const id = JSON.stringify([rk, ck])
    cells.set(id, (cells.get(id) ?? 0) + v)
  }
  // Columns read left to right in order: dates and periods sort as text, which is their order.
  colKeys.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const grid = rowKeys.map(rk => colKeys.map(ck => cells.get(JSON.stringify([rk, ck])) ?? null))
  const totals = block.type === 'heatmap' ? block.totals === true : block.totals !== false
  return {
    ...base, status: 'ok', format: block.format,
    pivot: {
      rowLabel: humanize(block.rows),
      rows: rowKeys,
      columns: colKeys,
      cells: grid,
      ...(totals ? {
        rowTotals: grid.map(r => r.reduce((s: number, v) => s + (v ?? 0), 0)),
        columnTotals: colKeys.map((_, j) => grid.reduce((s, r) => s + (r[j] ?? 0), 0)),
        grandTotal: grid.reduce((s, r) => s + r.reduce((t: number, v) => t + (v ?? 0), 0), 0),
      } : {}),
    },
  }
}

const humanLabel = (column: string) => humanize(column)

/** A chart block's figures, shaped for its type. Rows past MAX_CHART_POINTS are left off. */
function chartBlock(block: ChartBlock, base: Pick<CustomBlock, 'id' | 'type' | 'label' | 'span'>, rows: Row[]): CustomBlock {
  const ok = { ...base, status: 'ok' as const, format: block.format }
  const label = (r: Row) => String(cell(r[block.x]) ?? '—')
  if (block.series) {
    return { ...ok, ...(block.stack ? { stack: block.stack } : {}), ...pivotSeries(rows, block.x, block.y, block.series) }
  }
  if (block.measures?.length) {
    // Each measure is a series of its own; bars set them side by side unless asked to stack.
    const cols = [block.y, ...block.measures]
    const num = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0)
    const points = rows.slice(0, MAX_CHART_POINTS).map(r => {
      const values = cols.map(c => num(r[c]))
      return { label: label(r), value: values.reduce((t, v) => t + v, 0), values }
    })
    return { ...ok, stack: block.stack ?? (block.type === 'area' ? 'stacked' : 'grouped'), series: cols.map(humanize), points }
  }
  if (block.type === 'scatter') {
    const dots = rows
      .map((r, i) => ({ label: block.point_label ? String(cell(r[block.point_label]) ?? '—') : `Point ${i + 1}`, x: Number(r[block.x]), y: Number(r[block.y]) }))
      .filter(d => Number.isFinite(d.x) && Number.isFinite(d.y))
      .slice(0, MAX_SCATTER_POINTS)
    return { ...ok, dots, xFormat: block.x_format ?? 'number' }
  }
  if (block.type === 'combo') {
    const points = rows
      .map(r => ({ label: label(r), value: Number(r[block.y]), value2: Number(r[block.y2!]) }))
      .filter(p => Number.isFinite(p.value) || Number.isFinite(p.value2))
      .map(p => ({ label: p.label, value: Number.isFinite(p.value) ? p.value : 0, value2: Number.isFinite(p.value2) ? p.value2 : 0 }))
      .slice(0, MAX_CHART_POINTS)
    return { ...ok, points, label2: humanLabel(block.y2!), format2: block.format2 ?? block.format }
  }
  let points = rows
    .map(r => ({ label: label(r), value: Number(r[block.y]) }))
    .filter(p => Number.isFinite(p.value))
    .slice(0, MAX_CHART_POINTS)
  if (block.type === 'pie') {
    // Shares of a total: negative slices have no meaning, and past eight the smallest fold together.
    const positive = points.filter(p => p.value > 0).sort((a, b) => b.value - a.value)
    points = positive.length > MAX_SERIES
      ? [...positive.slice(0, MAX_SERIES - 1), { label: 'Other', value: positive.slice(MAX_SERIES - 1).reduce((s, p) => s + p.value, 0) }]
      : positive
    return { ...ok, points, ...(block.donut ? { donut: true } : {}) }
  }
  if (block.type === 'waterfall') return { ...ok, points, total: block.total !== false }
  return { ...ok, points }
}

function formulaTile(block: FormulaKpiBlock, specBlocks: ViewBlock[], loaded: (CustomBlock | null)[]): CustomBlock {
  const base = { id: block.id, type: 'kpi' as const, label: block.label, span: block.span }
  const figures: Record<string, unknown> = {}
  const missing: string[] = []
  specBlocks.forEach((b, i) => {
    const out = loaded[i]
    if (b.type !== 'kpi' || isFormulaBlock(b) || !out) return
    if (out.status === 'ok') figures[b.id] = out.value
    else missing.push(b.label || b.id)
  })
  let expr
  try { expr = parseFormula(block.formula, specBlocks.filter(b => b.type === 'kpi' && !isFormulaBlock(b)).map(b => b.id)) }
  catch (e) { return { ...base, status: 'error', message: (e as Error).message } }
  const names = new Set<string>()
  const walk = (e: typeof expr): void => {
    if (e.k === 'col') names.add(e.name)
    else if (e.k === 'neg') walk(e.e)
    else if (e.k === 'bin') { walk(e.a); walk(e.b) }
    else if (e.k === 'fn') e.args.forEach(walk)
  }
  walk(expr)
  // A tile this viewer cannot read makes the figure unknowable to them, not zero.
  const denied = specBlocks.filter(b => names.has(b.id) && missing.includes(b.label || b.id))
  if (denied.length) return { ...base, status: 'denied', message: `Uses ${denied.map(b => b.label || b.id).join(', ')}, which you cannot see.` }
  return { ...base, status: 'ok', format: block.format, value: evaluate(expr, figures), ...(block.sub ? { sub: block.sub } : {}) }
}

function textBlock(block: ViewBlock & { type: 'text' }): CustomBlock {
  return { id: block.id, type: 'text', label: block.label, span: block.span, status: 'ok', text: block.text }
}

/** Load every block of a view, as the viewer, and lay it out as a payload the renderers draw. */
export async function resolveView(deps: ResolveDeps, spec: ViewSpec, rawParams: unknown, ref: ViewRef): Promise<CustomViewPayload> {
  const values = cleanParams(spec, rawParams)
  const filters = spec.filters ?? []
  const lc: LoadContext = {
    values,
    filters,
    filterValues: cleanFilterValues(spec, rawParams),
    options: new Map(),
    cache: new Map(),
    today: new Date().toISOString().slice(0, 10),
  }
  const [branding, vehicles, blocks] = await Promise.all([
    (deps.branding ?? (() => loadBranding(deps.admin, deps.fundId)))(),
    spec.params.includes('vehicle') ? viewerVehicles(deps) : Promise.resolve([] as string[]),
    Promise.all(spec.blocks.map(b => (isDataBlock(b) ? loadBlock(deps, b, lc) : isFormulaBlock(b) ? Promise.resolve(null) : Promise.resolve(textBlock(b as ViewBlock & { type: 'text' }))))),
  ])
  // A ledger dataset reads one entity's books, so a view opened on "all entities" cannot load it
  // once the fund has several: every such block would say "Specify a vehicle". Open it on the
  // viewer's first entity instead; values.vehicle then names it in the subtitle and the picker.
  if (lc.needsVehicle && vehicles.length > 1 && !values.vehicle) {
    return resolveView(deps, spec, { ...(rawParams as Record<string, unknown> ?? {}), vehicle: vehicles[0] }, ref)
  }
  // Formula tiles last: they read the figures the other tiles loaded, as this viewer.
  spec.blocks.forEach((b, i) => { if (isFormulaBlock(b)) blocks[i] = formulaTile(b, spec.blocks, blocks) })
  // The filters' current values travel as plain params too, so links and exports reopen the same view.
  const filterArgs: Record<string, string> = {}
  for (const [column, v] of Object.entries(lc.filterValues)) {
    if (v.pick) filterArgs[`filter.${column}`] = v.pick
    if (v.from) filterArgs[`filter.${column}.from`] = v.from
    if (v.to) filterArgs[`filter.${column}.to`] = v.to
  }
  const filterNotes = filters.flatMap(f => {
    const v = lc.filterValues[f.column]
    if (!v) return []
    if (v.pick) return [`${f.label}: ${v.pick}`]
    return [`${f.label} ${v.from && v.to ? `${v.from} to ${v.to}` : v.from ? `from ${v.from}` : `to ${v.to}`}`]
  })
  const subtitle = [values.vehicle ?? (spec.params.includes('vehicle') ? 'All vehicles' : null), values.as_of ? `as of ${values.as_of}` : null, ...filterNotes]
    .filter(Boolean).join(' · ') || null
  return {
    view: 'custom',
    title: ref.name ?? spec.title,
    subtitle,
    args: { ...(ref.id ? { view: ref.id } : {}), ...values, ...filterArgs },
    generatedAt: new Date().toISOString(),
    branding,
    data: {
      id: ref.id,
      url: ref.url ?? null,
      description: spec.description ?? null,
      params: spec.params,
      values: { ...(values as Record<string, string>), ...filterArgs },
      vehicles,
      ...(filters.length ? {
        filters: filters.map(f => ({
          column: f.column,
          label: f.label,
          kind: f.kind,
          ...(f.kind === 'pick' ? { options: Array.from(lc.options.get(f.column) ?? []).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) } : {}),
          ...(f.kind === 'range' ? { input: rangeInput(spec, f.column) } : {}),
          ...(lc.filterValues[f.column] ? { value: lc.filterValues[f.column] } : {}),
        })),
      } : {}),
      blocks: blocks as CustomBlock[],
    },
  }
}

/** A range filter takes dates when any dataset the view reads holds that column as a date. */
function rangeInput(spec: ViewSpec, column: string): 'date' | 'number' {
  const types = spec.blocks.filter(isDataBlock).flatMap(b => (findDataset(b.source.tool, b.source.dataset)?.columns ?? []).filter(c => c.name === column).map(c => c.type))
  return types.includes('date') ? 'date' : 'number'
}

/** The entities the viewer may pick: only their own, as the dashboards' entity pickers do. */
async function viewerVehicles(deps: ResolveDeps): Promise<string[]> {
  if (deps.vehicles) return deps.vehicles()
  const [all, scope] = await Promise.all([
    listVehicles(deps.admin, deps.fundId).catch(() => [] as string[]),
    entityScopeFor(deps.admin, deps.access),
  ])
  return scope.vehicleNames === null ? all : all.filter(v => scope.vehicleNames!.includes(v))
}
