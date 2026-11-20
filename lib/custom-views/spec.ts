// Custom views: the spec a member describes in words and an assistant writes down.
//
// A view is a RECIPE, never a result, exactly like a saved dashboard (lib/mcp-apps/saved-dashboards.ts).
// It is a title, a few view-level parameters and a list of blocks from a FIXED set (tiles, bar and
// line charts, tables, text). Each data block names a query dataset (lib/agent/query/catalog.ts) and
// a query the existing engine understands. No figure, no HTML, no code: opening a view loads every
// block again as the person opening it (resolve.ts), through that dataset's own access check.
//
// Pure: no server imports. The validator runs on the way IN (preview, save) and on the way OUT
// (open), so a row edited by hand, or a spec written before a dataset changed, still only ever
// replays as known blocks over known columns, or fails one block with a clear message.

import { QUERY_CATALOG, type DatasetMeta } from '@/lib/agent/query/catalog'
import { QueryError, runQuery, type QuerySpec } from '@/lib/agent/query/engine'

export const SPEC_VERSION = 1

export const CHART_TYPES = ['bar', 'column', 'line', 'area', 'pie', 'scatter', 'combo', 'waterfall', 'funnel'] as const
export type ChartType = (typeof CHART_TYPES)[number]

export const BLOCK_TYPES = ['kpi', ...CHART_TYPES, 'table', 'text'] as const
export type BlockType = (typeof BLOCK_TYPES)[number]

export const VALUE_FORMATS = ['currency', 'number', 'percent', 'multiple', 'date', 'text'] as const
export type ValueFormat = (typeof VALUE_FORMATS)[number]

/** Grid widths out of 12. A phone stacks every block full width. */
export const BLOCK_SPANS = [3, 4, 6, 8, 12] as const
export type BlockSpan = (typeof BLOCK_SPANS)[number]

/** The parameters a view can expose. They are the two every dataset loader takes. */
export const VIEW_PARAMS = ['vehicle', 'as_of'] as const
export type ViewParam = (typeof VIEW_PARAMS)[number]

export const MAX_BLOCKS = 24
export const MAX_TITLE = 120
export const MAX_LABEL = 80
export const MAX_TEXT = 4000
export const MAX_TABLE_COLUMNS = 12

export class ViewSpecError extends Error {}

export interface BlockSource {
  /** A query tool: query_portfolio, query_lps, query_deals, query_diligence, query_ledger. */
  tool: string
  dataset: string
  query: QuerySpec
}

export interface TableColumn { column: string; label?: string; format?: ValueFormat }

interface BlockBase { id: string; label: string; span: BlockSpan }

export interface KpiBlock extends BlockBase {
  type: 'kpi'
  source: BlockSource
  /** The result column whose FIRST row is the figure. */
  value: string
  format: ValueFormat
  /** Fine print under the figure. */
  sub?: string
}

/**
 * Every chart: x is the category, period or slice column and y the measure, except a scatter,
 * where x and y are both numbers and `point_label` names each dot.
 *
 * - bar (horizontal) and column (vertical) compare categories; line and area follow time.
 * - pie shows shares of one total (donut: true draws a ring). At most 8 slices; the rest are "Other".
 * - scatter plots one dot per row at (x, y), e.g. MOIC against holding period.
 * - combo draws y as bars and y2 as a line on its own axis on the right, e.g. calls and NAV.
 * - waterfall reads y as changes and draws each step from the running total, then the total.
 * - funnel draws each stage's y as a centred bar, widest first, e.g. deals by pipeline stage.
 */
export interface ChartBlock extends BlockBase {
  type: ChartType
  source: BlockSource
  /** The category, period or slice column (a number column for a scatter). */
  x: string
  /** The measure column. */
  y: string
  /** combo: the line's measure, on the right axis. */
  y2?: string
  /** combo: the line's format. */
  format2?: ValueFormat
  /** scatter: the column that names each dot. */
  point_label?: string
  /** scatter: the format of x. */
  x_format?: ValueFormat
  /** bar and column with a series: stacked (default) or side by side. area with a series always stacks. */
  stack?: 'stacked' | 'grouped'
  /** pie: a ring rather than a disc. */
  donut?: boolean
  /** waterfall: end with a bar for the total (default true). */
  total?: boolean
  /**
   * Optional: a result column that splits the measure into one series per value (stage, vehicle,
   * sector). Bars stack the series; a line chart draws one line per series. The query groups by
   * both x and series, so each row is one (x, series) pair.
   */
  series?: string
  format: ValueFormat
}

/** Series per chart. The rest are folded into "Other", so a legend stays readable. */
export const MAX_SERIES = 8

export interface TableBlock extends BlockBase {
  type: 'table'
  source: BlockSource
  /** Which result columns to show, in order. Default: every result column. */
  columns: TableColumn[]
}

export interface TextBlock extends BlockBase {
  type: 'text'
  /** Plain text. Blank lines separate paragraphs. Never rendered as HTML. */
  text: string
}

export type ViewBlock = KpiBlock | ChartBlock | TableBlock | TextBlock
export type DataBlock = KpiBlock | ChartBlock | TableBlock

export interface ViewSpec {
  spec_version: number
  title: string
  description?: string
  /** Which parameters the view offers as filters. */
  params: ViewParam[]
  blocks: ViewBlock[]
}

export const isDataBlock = (b: ViewBlock): b is DataBlock => b.type !== 'text'

// ---------------------------------------------------------------------------------------------
// Catalog lookups
// ---------------------------------------------------------------------------------------------

export function findDataset(tool: string, dataset: string): DatasetMeta | undefined {
  return QUERY_CATALOG[tool]?.find(d => d.name === dataset)
}

/** One line per dataset, for an assistant that needs to know what it can bind a block to. */
export function catalogSummary(): { tool: string; dataset: string; description: string; columns: string[] }[] {
  return Object.entries(QUERY_CATALOG).flatMap(([tool, sets]) =>
    sets.map(d => ({ tool, dataset: d.name, description: d.description, columns: d.columns.map(c => c.name) })))
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function cleanText(raw: unknown, max: number, what: string, required = true): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new ViewSpecError(`${what} is required.`)
    return undefined
  }
  if (typeof raw !== 'string') throw new ViewSpecError(`${what} must be text.`)
  // Control characters out (newlines kept only where the caller keeps them), whitespace trimmed.
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  if (!text && required) throw new ViewSpecError(`${what} is required.`)
  if (text.length > max) throw new ViewSpecError(`${what} can be at most ${max} characters.`)
  return text || undefined
}

const oneLine = (raw: unknown, max: number, what: string, required = true) =>
  cleanText(typeof raw === 'string' ? raw.replace(/\s+/g, ' ') : raw, max, what, required)

function pick<T extends string>(raw: unknown, allowed: readonly T[], what: string, fallback?: T): T {
  if ((raw === undefined || raw === null || raw === '') && fallback !== undefined) return fallback
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T
  throw new ViewSpecError(`${what} must be one of: ${allowed.join(', ')}.`)
}

/** Only the engine's own keys survive, so a stored query cannot carry anything else. */
function cleanQuery(raw: unknown): QuerySpec {
  if (raw === undefined || raw === null) return {}
  if (!isObject(raw)) throw new ViewSpecError('query must be an object.')
  const out: QuerySpec = {}
  for (const key of ['columns', 'where', 'group_by', 'aggregates', 'order_by'] as const) {
    if (raw[key] === undefined) continue
    if (!Array.isArray(raw[key])) throw new ViewSpecError(`query.${key} must be a list.`)
    ;(out as Record<string, unknown>)[key] = raw[key]
  }
  if (raw.limit !== undefined) {
    const n = Number(raw.limit)
    if (!Number.isInteger(n) || n < 1) throw new ViewSpecError('query.limit must be a whole number of at least 1.')
    out.limit = n
  }
  // Values in filters are data, not instructions, but they still need a bound.
  if (JSON.stringify(out).length > 8000) throw new ViewSpecError('query is too long.')
  return out
}

function cleanSource(raw: unknown, where: string): { source: BlockSource; resultColumns: string[] } {
  if (!isObject(raw)) throw new ViewSpecError(`${where}: source is required ({ tool, dataset, query }).`)
  const tool = typeof raw.tool === 'string' ? raw.tool : ''
  if (!QUERY_CATALOG[tool]) {
    throw new ViewSpecError(`${where}: source.tool must be one of: ${Object.keys(QUERY_CATALOG).join(', ')}.`)
  }
  const dataset = typeof raw.dataset === 'string' ? raw.dataset : ''
  const meta = findDataset(tool, dataset)
  if (!meta) {
    throw new ViewSpecError(`${where}: ${tool} has no dataset "${dataset}". Datasets: ${QUERY_CATALOG[tool].map(d => d.name).join(', ')}.`)
  }
  const query = cleanQuery(raw.query)
  let resultColumns: string[]
  try {
    // The engine over no rows checks every column, filter op, aggregate and sort, and names the
    // columns the result will have, without loading anything.
    resultColumns = runQuery([], meta.columns, query).columns
  } catch (e) {
    if (e instanceof QueryError) throw new ViewSpecError(`${where}: ${e.message}`)
    throw e
  }
  return { source: { tool, dataset, query }, resultColumns }
}

function resultColumn(raw: unknown, columns: string[], where: string, what: string): string {
  if (typeof raw === 'string' && columns.includes(raw)) return raw
  throw new ViewSpecError(`${where}: ${what} must be a column of the result: ${columns.join(', ')}.`)
}

function cleanBlock(raw: unknown, index: number, seen: Set<string>): ViewBlock {
  const where = `Block ${index + 1}`
  if (!isObject(raw)) throw new ViewSpecError(`${where} must be an object.`)
  const type = pick(raw.type, BLOCK_TYPES, `${where}: type`)
  let id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!/^[a-z0-9_-]{1,40}$/i.test(id) || seen.has(id)) id = `b${index + 1}`
  while (seen.has(id)) id = `${id}_`
  seen.add(id)
  const label = oneLine(raw.label, MAX_LABEL, `${where}: label`, type !== 'text') ?? ''
  const span = (BLOCK_SPANS as readonly number[]).includes(Number(raw.span))
    ? (Number(raw.span) as BlockSpan)
    : type === 'kpi' ? 3 : type === 'text' ? 12 : 6
  const base = { id, label, span }

  if (type === 'text') {
    return { ...base, type, text: cleanText(raw.text, MAX_TEXT, `${where}: text`)! }
  }

  const { source, resultColumns } = cleanSource(raw.source, where)

  if (type === 'kpi') {
    const value = raw.value === undefined && resultColumns.length === 1
      ? resultColumns[0]
      : resultColumn(raw.value, resultColumns, where, 'value')
    return {
      ...base, type, source, value,
      format: pick(raw.format, VALUE_FORMATS, `${where}: format`, 'number'),
      ...(oneLine(raw.sub, MAX_LABEL, `${where}: sub`, false) ? { sub: oneLine(raw.sub, MAX_LABEL, `${where}: sub`, false) } : {}),
    }
  }

  if ((CHART_TYPES as readonly string[]).includes(type)) {
    const chart = type as ChartType
    const x = resultColumn(raw.x, resultColumns, where, 'x')
    const y = resultColumn(raw.y, resultColumns, where, 'y')
    const given = (v: unknown) => v !== undefined && v !== null && v !== ''
    const out: ChartBlock = { ...base, type: chart, source, x, y, format: pick(raw.format, VALUE_FORMATS, `${where}: format`, 'number') }
    if (given(raw.series)) {
      if (!['bar', 'column', 'line', 'area'].includes(chart)) throw new ViewSpecError(`${where}: series works on bar, column, line and area charts.`)
      const series = resultColumn(raw.series, resultColumns, where, 'series')
      if (series === x || series === y) throw new ViewSpecError(`${where}: series must be a different column from x and y.`)
      out.series = series
      if (given(raw.stack)) out.stack = pick(raw.stack, ['stacked', 'grouped'] as const, `${where}: stack`)
    }
    if (chart === 'combo') {
      out.y2 = resultColumn(raw.y2, resultColumns, where, 'y2')
      out.format2 = pick(raw.format2, VALUE_FORMATS, `${where}: format2`, out.format)
    }
    if (chart === 'scatter') {
      if (given(raw.point_label)) out.point_label = resultColumn(raw.point_label, resultColumns, where, 'point_label')
      out.x_format = pick(raw.x_format, VALUE_FORMATS, `${where}: x_format`, 'number')
    }
    if (chart === 'pie' && raw.donut === true) out.donut = true
    if (chart === 'waterfall' && raw.total === false) out.total = false
    return out
  }

  // table
  const rawColumns = raw.columns === undefined ? resultColumns.map(column => ({ column })) : raw.columns
  if (!Array.isArray(rawColumns) || rawColumns.length === 0) throw new ViewSpecError(`${where}: columns must be a non-empty list.`)
  if (rawColumns.length > MAX_TABLE_COLUMNS) throw new ViewSpecError(`${where}: at most ${MAX_TABLE_COLUMNS} columns.`)
  const columns: TableColumn[] = rawColumns.map((c: unknown, i: number) => {
    const entry = typeof c === 'string' ? { column: c } : c
    if (!isObject(entry)) throw new ViewSpecError(`${where}: column ${i + 1} must be a column name or { column, label, format }.`)
    const col: TableColumn = { column: resultColumn(entry.column, resultColumns, where, `column ${i + 1}`) }
    const lbl = oneLine(entry.label, MAX_LABEL, `${where}: column ${i + 1} label`, false)
    if (lbl) col.label = lbl
    if (entry.format !== undefined) col.format = pick(entry.format, VALUE_FORMATS, `${where}: column ${i + 1} format`)
    return col
  })
  return { ...base, type: 'table' as const, source, columns }
}

/**
 * Check a spec and return it reduced to known keys. Throws ViewSpecError with a message an
 * assistant can act on (it names the allowed values and the result's columns).
 */
export function parseViewSpec(raw: unknown): ViewSpec {
  const input = typeof raw === 'string' ? safeJson(raw) : raw
  if (!isObject(input)) throw new ViewSpecError('A view spec must be an object.')
  const version = input.spec_version === undefined ? SPEC_VERSION : Number(input.spec_version)
  if (version !== SPEC_VERSION) throw new ViewSpecError(`spec_version ${String(input.spec_version)} is not supported; use ${SPEC_VERSION}.`)
  const title = oneLine(input.title, MAX_TITLE, 'title')!
  const description = oneLine(input.description, 300, 'description', false)
  const rawParams = input.params === undefined ? [] : input.params
  if (!Array.isArray(rawParams)) throw new ViewSpecError(`params must be a list of: ${VIEW_PARAMS.join(', ')}.`)
  const params = Array.from(new Set(rawParams.map(p => pick(isObject(p) ? p.key : p, VIEW_PARAMS, 'params'))))
  if (!Array.isArray(input.blocks) || input.blocks.length === 0) throw new ViewSpecError('A view needs at least one block.')
  if (input.blocks.length > MAX_BLOCKS) throw new ViewSpecError(`A view can have at most ${MAX_BLOCKS} blocks.`)
  const seen = new Set<string>()
  const blocks = input.blocks.map((b, i) => cleanBlock(b, i, seen))
  return { spec_version: SPEC_VERSION, title, ...(description ? { description } : {}), params, blocks }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ViewSpecError('The spec is not valid JSON.')
  }
}

/** The parameter values a view is opened with, reduced to the ones it offers. */
export function cleanParams(spec: ViewSpec, raw: unknown): Partial<Record<ViewParam, string>> {
  const input = isObject(raw) ? raw : {}
  const out: Partial<Record<ViewParam, string>> = {}
  for (const key of spec.params) {
    const value = input[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string' || value.length > 200) throw new ViewSpecError(`${key} must be short text.`)
    if (key === 'as_of' && !isRealDate(value)) throw new ViewSpecError('as_of must be a real date (YYYY-MM-DD).')
    out[key] = value.trim()
  }
  return out
}

function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
