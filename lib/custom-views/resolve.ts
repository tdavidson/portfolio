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
import { QUERY_LOADERS, type DatasetParams } from '@/lib/agent/query/datasets'
import { runQuery } from '@/lib/agent/query/engine'
import { loadBranding } from '@/lib/mcp-apps/branding'
import type { CustomBlock, CustomValueFormat, CustomViewPayload, DashboardBranding } from '@/lib/mcp-apps/payload'
import {
  cleanParams, findDataset, isDataBlock, MAX_SERIES,
  type ChartBlock, type DataBlock, type TableBlock, type ViewBlock, type ViewParam, type ViewSpec,
} from './spec'

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

async function loadBlock(
  deps: ResolveDeps,
  block: DataBlock,
  values: Partial<Record<ViewParam, string>>,
  cache: Map<string, Promise<Row[]>>,
): Promise<CustomBlock> {
  const base = { id: block.id, type: block.type, label: block.label, span: block.span }
  const { tool: toolName, dataset, query } = block.source
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
    const key = JSON.stringify([dataset, portfolioGroup, values.vehicle ?? null, values.as_of ?? null])
    let rows = cache.get(key)
    if (!rows) {
      const loader = (deps.loaders ?? QUERY_LOADERS)[dataset]
      if (!loader) return { ...base, status: 'error', message: `${dataset} has no loader.` }
      const ctx: AgentToolContext = { admin: deps.admin, fundId: deps.fundId, portfolioGroup, userId: deps.userId, access: deps.access }
      rows = loader(ctx, { vehicle: values.vehicle, as_of: values.as_of })
      cache.set(key, rows)
    }
    const result = runQuery(await rows, meta.columns, query)

    if (block.type === 'kpi') {
      const first = result.rows[0]
      return { ...base, status: 'ok', format: block.format, value: first ? cell(first[block.value]) : null, ...(block.sub ? { sub: block.sub } : {}) }
    }
    if (block.type !== 'table') return chartBlock(block, base, result.rows)
    const columns = (block as TableBlock).columns.map(c => ({
      key: c.column,
      label: c.label ?? humanize(c.column),
      format: c.format ?? guessFormat(c.column, result.rows.find(r => r[c.column] != null)?.[c.column]),
    }))
    const rows2 = result.rows.map(r => Object.fromEntries(columns.map(c => [c.key, cell(r[c.key])])))
    return { ...base, status: 'ok', columns, rows: rows2, truncated: result.truncated }
  } catch (e) {
    return { ...base, status: 'error', message: (e as Error).message || 'Could not load this block.' }
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

function textBlock(block: ViewBlock & { type: 'text' }): CustomBlock {
  return { id: block.id, type: 'text', label: block.label, span: block.span, status: 'ok', text: block.text }
}

/** Load every block of a view, as the viewer, and lay it out as a payload the renderers draw. */
export async function resolveView(deps: ResolveDeps, spec: ViewSpec, rawParams: unknown, ref: ViewRef): Promise<CustomViewPayload> {
  const values = cleanParams(spec, rawParams)
  const cache = new Map<string, Promise<Row[]>>()
  const [branding, vehicles, blocks] = await Promise.all([
    (deps.branding ?? (() => loadBranding(deps.admin, deps.fundId)))(),
    spec.params.includes('vehicle') ? viewerVehicles(deps) : Promise.resolve([] as string[]),
    Promise.all(spec.blocks.map(b => (isDataBlock(b) ? loadBlock(deps, b, values, cache) : Promise.resolve(textBlock(b))))),
  ])
  const subtitle = [values.vehicle ?? (spec.params.includes('vehicle') ? 'All vehicles' : null), values.as_of ? `as of ${values.as_of}` : null]
    .filter(Boolean).join(' · ') || null
  return {
    view: 'custom',
    title: ref.name ?? spec.title,
    subtitle,
    args: { ...(ref.id ? { view: ref.id } : {}), ...values },
    generatedAt: new Date().toISOString(),
    branding,
    data: {
      id: ref.id,
      url: ref.url ?? null,
      description: spec.description ?? null,
      params: spec.params,
      values: values as Record<string, string>,
      vehicles,
      blocks,
    },
  }
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
