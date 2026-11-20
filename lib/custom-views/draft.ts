// Build a view spec from words, with the fund's own model: what the "New view" page in the app runs.
//
// The model's only job is translation: pick blocks, datasets and columns from the catalog, and
// write queries the engine already understands. It sees the catalog's names and column types,
// never a row of data, and what it returns is validated by parseViewSpec exactly as a spec from a
// connected assistant is. When the spec does not validate, the model gets the validator's message
// (which names what is allowed) and one more try.
//
// The provider is passed in, so this is tested with a stand-in and works with any provider the
// fund configured.

import type { AIProvider, TokenUsage } from '@/lib/ai/types'
import { QUERY_CATALOG } from '@/lib/agent/query/catalog'
import { AGGREGATES, DATE_BUCKETS, FILTER_OPS } from '@/lib/agent/query/engine'
import {
  BLOCK_SPANS, MAX_BLOCKS, VALUE_FORMATS, VIEW_PARAMS,
  parseViewSpec, ViewSpecError, type ViewSpec,
} from './spec'

export const MAX_INSTRUCTION = 2000
export const DRAFT_ATTEMPTS = 2

export class ViewDraftError extends Error {}

function catalogText(): string {
  return Object.entries(QUERY_CATALOG).map(([tool, sets]) =>
    sets.map(d => `- tool "${tool}", dataset "${d.name}": ${d.description}\n  columns: ${d.columns.map(c => `${c.name} (${c.type}${c.description ? `: ${c.description}` : ''})`).join(', ')}`).join('\n'),
  ).join('\n')
}

/** The system prompt: the spec format, the datasets, and the rules. No fund data. */
export function draftSystemPrompt(): string {
  return [
    'You turn a description of a fund dashboard into a JSON view spec. Reply with the JSON object only: no prose, no code fence.',
    '',
    'Spec: { "title": string, "description"?: string, "params"?: subset of ' + JSON.stringify(VIEW_PARAMS) + ', "blocks": Block[] }',
    `At most ${MAX_BLOCKS} blocks. Every block may set "id" (short slug) and "span" (one of ${BLOCK_SPANS.join(', ')}, out of 12; tiles usually 3, charts and tables 6 or 12).`,
    'Block types:',
    '- { "type": "kpi", "label", "source", "value": result column, "format", "sub"?: fine print } shows the first row of one column. Usually an aggregate with no group_by. "compare": "prior_month" | "prior_quarter" | "prior_year" also loads the figure at that earlier date and shows the change. "trend": { "source", "x", "y" } adds a sparkline under the figure (y over x, oldest first; say NAV by quarter).',
    '- { "type": "kpi", "label", "formula", "format" } works out a figure from OTHER kpi blocks by id, which may read different datasets: give the tiles ids of letters, digits and _ and write, say, "nav / fair_value" (the + - * / and functions of computed columns).',
    '- { "type": "gauge", "label", "source", "value", "format", "max"?: number, "max_column"?: result column, "target"?: number } a dial of the first row of value against max (percent defaults to 100). Say called against committed (max_column).',
    '- Charts: { "type", "label", "source", "x": label column, "y": number column, "format", ...options }. Types:',
    '  "bar" (horizontal) or "column" (vertical) compare categories (sort desc, limit 10-15). "line" or "area" follow time (group_by a date bucket, oldest first).',
    '  "pie" shows shares of one total; "donut": true draws a ring. At most 8 slices; the rest become "Other".',
    '  "scatter": x and y are both NUMBER columns, one dot per row; "point_label": the column naming each dot; "x_format" formats x. Ungrouped columns, e.g. MOIC against invested.',
    '  "combo": bars of y plus a line of "y2" on a right-hand axis; "format2" formats y2. E.g. calls (bars) and NAV (line) by quarter.',
    '  "waterfall": y is the CHANGE at each step; bars float from the running total, then a total bar ("total": false leaves it off).',
    '  "funnel": stages in order (order_by the stage, or by y desc), each y a centred bar, with its share of the first stage.',
    '  "measures" (bar, column, line, area): more result columns beside y, each its own series (called and distributed by quarter). Bars set them side by side unless "stack": "stacked". Not with series.',
    '  "series" (bar, column, line, area): a column that splits the measure (stage, vehicle, sector); group_by BOTH x and series with one aggregate as y. Bars and columns stack the series, or "stack": "grouped" sets them side by side; lines draw one line each; areas stack. At most 8 series; the rest become "Other".',
    '- { "type": "table", "label", "source", "columns"?: [{ "column", "label"?, "format"? }], "totals"?: true } ("totals" adds a row summing each currency and number column). "subtotal_by": a result column groups the rows with a subtotal after each group. A column may set "tone": "sign" (losses red, gains green) or "scale" (shaded by size), and "link": "company" (each cell opens the company; the query must return company_id).',
    '- { "type": "pivot", "label", "source", "rows", "columns", "value", "format", "totals"?: false } a cross-tab of value by two result columns (company by vehicle, account by quarter): group_by both, one aggregate as value. Row and column totals unless "totals": false.',
    '- { "type": "heatmap", ... } is a pivot with each cell shaded by its value (losses red), no totals unless "totals": true. Good for KPIs by company and quarter, or returns by vintage.',
    '- { "type": "text", "text" } plain copy, for a short note. Never figures.',
    `format is one of ${VALUE_FORMATS.join(', ')}.`,
    '',
    'source is { "tool", "dataset", "query" }. query may have:',
    '  columns: [names] (ungrouped only)',
    `  where: [{ "column", "op": one of ${FILTER_OPS.join(', ')}, "value" }]`,
    `  group_by: [column or "date_column:bucket" with bucket ${DATE_BUCKETS.join('|')}] (the result column is named "date_column_bucket")`,
    `  aggregates: [{ "fn": one of ${AGGREGATES.join(', ')}, "column", "as": result name }] (sum/avg/median need a number column; without "as" the name is fn_column)`,
    '  order_by: [{ "column": a RESULT column, "direction": "asc"|"desc" }], limit: number (max 500)',
    'source may also have "computed": [{ "as": name, "formula" }], calculated columns over the result columns: numbers, column names, + - * /, parentheses, abs(x), min(a,b), max(a,b), round(x, places). A later one may use an earlier one; order_by may sort on one; dividing by zero gives no value. Example: { "as": "tvpi", "formula": "(distributed + nav) / called" }.',
    'value, x, y, y2, series, point_label and table columns must name RESULT columns: after an aggregate, only the group_by columns and the aggregates exist.',
    'Use "params": ["vehicle"] when the person wants to filter by fund or entity, and "as_of" when they want a date. Do not hard-code a vehicle or a date in a where filter unless asked.',
    'For other filters the reader should change, add "filters": up to 6 { "column", "label"?, "kind"?: "pick"|"range" } on dataset columns (pick: a list of the values, say stage or sector; range: from/to on a date or number column). Each applies to every block whose dataset has that column.',
    '',
    'Datasets:',
    catalogText(),
    '',
    'Use only these tools, datasets and columns. Never invent figures: every block loads live.',
    'When given a current spec and a change, return the whole updated spec, keeping what the change does not touch.',
  ].join('\n')
}

/** The JSON object in a model's reply, tolerating a code fence or a sentence around it. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new ViewDraftError('The model did not return a view spec.')
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    throw new ViewDraftError('The model returned a spec that is not valid JSON.')
  }
}

export interface DraftResult {
  spec: ViewSpec
  usage: TokenUsage[]
  attempts: number
}

/**
 * Draft a spec from an instruction, or revise `current` by it. Throws ViewDraftError when the
 * model cannot produce a valid spec in DRAFT_ATTEMPTS tries; the message says what was wrong.
 */
export async function draftViewSpec(params: {
  provider: AIProvider
  model: string
  instruction: string
  current?: ViewSpec | null
  signal?: AbortSignal
}): Promise<DraftResult> {
  const instruction = params.instruction.trim()
  if (!instruction) throw new ViewDraftError('Describe the view you want.')
  if (instruction.length > MAX_INSTRUCTION) throw new ViewDraftError(`Keep the description under ${MAX_INSTRUCTION} characters.`)

  const ask = params.current
    ? `Current spec:\n${JSON.stringify(params.current)}\n\nChange it like this: ${instruction}`
    : `Build a view: ${instruction}`

  const usage: TokenUsage[] = []
  let content = ask
  let lastError = ''
  for (let attempt = 1; attempt <= DRAFT_ATTEMPTS; attempt++) {
    const result = await params.provider.createMessage({
      model: params.model,
      maxTokens: 4000,
      system: draftSystemPrompt(),
      content,
      signal: params.signal,
    })
    usage.push(result.usage)
    try {
      const spec = parseViewSpec(extractJson(result.text))
      return { spec, usage, attempts: attempt }
    } catch (e) {
      if (!(e instanceof ViewSpecError) && !(e instanceof ViewDraftError)) throw e
      lastError = e.message
      // One more try, with the validator's own words.
      content = `${ask}\n\nYour previous reply:\n${result.text.slice(0, 6000)}\n\nIt was rejected: ${lastError}\nReturn the corrected JSON spec only.`
    }
  }
  throw new ViewDraftError(`Could not build a valid view from that description (${lastError}). Try rewording it.`)
}
