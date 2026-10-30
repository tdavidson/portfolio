// Paste/CSV import for LP capital events.
//
// Deliberately DETERMINISTIC — no LLM. The other LP import (/api/lps/import) uses AI because
// it is parsing arbitrary spreadsheet exports into a wide metric row. These are individual
// capital movements: an LP, a date, a type, and an amount. A misparsed row here silently
// moves money in someone's capital account, and there is no reconciliation step that would
// catch it. A parser that says "row 7: I don't know who 'Acme Cap' is" is worth far more
// than one that guesses.
//
// Every row that can't be resolved is REPORTED, never dropped.

import { splitRecords, splitLine, pickDelim, parseAmount, normalizeDate } from './bank'
import { LP_EVENT_TYPE_VALUES, REDUCES_CAPITAL, type LpCapitalEventInput } from './lp-events'

export interface ParsedEventRow extends LpCapitalEventInput {
  /** The LP name as written in the file, for display in the preview. */
  lpName: string
  /** 1-based row number in the pasted text, so an error can point at it. */
  line: number
}

export interface EventParseResult {
  rows: ParsedEventRow[]
  errors: string[]
  /** Column indices we resolved, so the UI can show what it understood. */
  columns: Record<string, number>
}

const HEADER_RULES: { key: string; re: RegExp }[] = [
  { key: 'lp', re: /^(lp|investor|entity|partner|name|lp name|entity name|investor name)$/i },
  { key: 'date', re: /^(date|event date|transaction date|effective date|as of)$/i },
  { key: 'type', re: /^(type|event|event type|kind|category|source|source type|description type)$/i },
  { key: 'amount', re: /^(amount|value|capital|delta|\$|usd)$/i },
  { key: 'memo', re: /^(memo|note|notes|description|detail|details|comment)$/i },
]

function matchHeader(cell: string): string | null {
  const c = cell.trim().replace(/^["']|["']$/g, '')
  for (const r of HEADER_RULES) if (r.re.test(c)) return r.key
  return null
}

/** Map free text in the type column onto a source_type. Accepts the stored values verbatim
 *  as well as the words a human would actually type. */
const TYPE_ALIASES: { re: RegExp; type: string }[] = [
  { re: /^(opening|opening balance|beginning|beginning balance|open)$/i, type: 'opening_balance' },
  { re: /^(capital call|call|contribution|contrib|paid in|paid-in|subscription|drawdown)$/i, type: 'capital_call' },
  { re: /^(distribution|dist|distrib|return of capital|roc|payout)$/i, type: 'distribution' },
  { re: /^(management fee|mgmt fee|mgmt|fee|management)$/i, type: 'management_fee' },
  { re: /^(partnership expense|expense|expenses|fund expense|operating expense)$/i, type: 'partnership_expense' },
  { re: /^(organizational expense|org expense|organisational expense|formation)$/i, type: 'organizational_expense' },
  { re: /^(income|interest|dividend|dividends|operating income)$/i, type: 'income' },
  { re: /^(realized|realized gain|realised gain|realized gain\/loss|gain|exit)$/i, type: 'realized_gain' },
  { re: /^(unrealized|unrealised|unrealized gain|valuation|mark|markup|markdown|revaluation)$/i, type: 'valuation' },
  { re: /^(fx|fx translation|fx revaluation|currency|translation)$/i, type: 'fx_revaluation' },
  { re: /^(carry|carried interest|carried|incentive)$/i, type: 'carried_interest' },
  { re: /^(transfer|assignment)$/i, type: 'transfer' },
  { re: /^(secondary|secondary sale|secondary transfer)$/i, type: 'secondary_transfer' },
  { re: /^(other|manual|misc|adjustment)$/i, type: 'manual' },
]

function resolveType(raw: string): string | null {
  const c = raw.trim()
  if (!c) return null
  if (LP_EVENT_TYPE_VALUES.includes(c)) return c
  for (const a of TYPE_ALIASES) if (a.re.test(c)) return a.type
  return null
}

const norm = (s: string) => s.replace(/[.,]/g, '').replace(/\s+/g, ' ').toLowerCase().trim()

/**
 * Parse pasted CSV/TSV into capital events.
 *
 * `entities` is the fund's LP roster — the parser will only ever emit an event for an LP
 * that already exists. It does NOT create LPs: inventing a partner from a typo in a
 * spreadsheet is exactly the kind of silent damage this import must not be capable of.
 *
 * Amounts are read with their natural sign (capitalDelta). If the file gives all amounts as
 * positive magnitudes — which most do — the event TYPE supplies the direction: a
 * distribution or a fee reduces capital. An explicit minus sign always wins.
 */
export function parseLpCapitalEvents(
  text: string,
  entities: { id: string; name: string }[]
): EventParseResult {
  const errors: string[] = []
  const rows: ParsedEventRow[] = []

  const records = splitRecords(text)
  if (records.length === 0) return { rows, errors: ['Nothing to import.'], columns: {} }

  const delim = pickDelim(records[0])
  const header = splitLine(records[0], delim)

  const columns: Record<string, number> = {}
  header.forEach((cell, i) => {
    const key = matchHeader(cell)
    if (key && columns[key] === undefined) columns[key] = i
  })

  for (const required of ['lp', 'date', 'amount'] as const) {
    if (columns[required] === undefined) {
      errors.push(
        `Missing a "${required}" column. Expected a header row with LP, Date, Type, Amount (Memo optional).`
      )
    }
  }
  if (errors.length > 0) return { rows, errors, columns }

  // Exact name first, then a normalized match ("Acme Capital, LLC" == "acme capital llc").
  const byExact = new Map(entities.map(e => [e.name, e.id]))
  const byNorm = new Map(entities.map(e => [norm(e.name), e.id]))

  for (let i = 1; i < records.length; i++) {
    const line = i + 1
    const cells = splitLine(records[i], delim)
    if (cells.every(c => !c.trim())) continue

    const rawLp = (cells[columns.lp] ?? '').trim()
    if (!rawLp) { errors.push(`Row ${line}: no LP name.`); continue }

    const lpEntityId = byExact.get(rawLp) ?? byNorm.get(norm(rawLp))
    if (!lpEntityId) {
      errors.push(`Row ${line}: no LP named "${rawLp}" in this fund. Add them first, or fix the spelling.`)
      continue
    }

    const eventDate = normalizeDate((cells[columns.date] ?? '').trim())
    if (!eventDate) { errors.push(`Row ${line}: couldn't read the date "${cells[columns.date] ?? ''}".`); continue }

    const rawType = columns.type !== undefined ? (cells[columns.type] ?? '') : ''
    const sourceType = resolveType(rawType)
    if (!sourceType) {
      errors.push(
        rawType.trim()
          ? `Row ${line}: unknown event type "${rawType.trim()}".`
          : `Row ${line}: no event type given.`
      )
      continue
    }

    const magnitude = parseAmount((cells[columns.amount] ?? '').trim())
    if (magnitude == null) { errors.push(`Row ${line}: couldn't read the amount "${cells[columns.amount] ?? ''}".`); continue }
    if (magnitude === 0) { errors.push(`Row ${line}: amount is zero.`); continue }

    // A file that writes distributions as positive magnitudes is the norm, so the type
    // decides the direction — unless the file was explicit about the sign, in which case
    // trust it.
    const explicitlySigned = /-|\(/.test((cells[columns.amount] ?? '').trim())
    const capitalDelta = explicitlySigned
      ? magnitude
      : REDUCES_CAPITAL.includes(sourceType)
        ? -Math.abs(magnitude)
        : magnitude

    rows.push({
      lpEntityId,
      lpName: rawLp,
      eventDate,
      sourceType,
      capitalDelta,
      memo: columns.memo !== undefined ? ((cells[columns.memo] ?? '').trim() || null) : null,
      line,
    })
  }

  if (rows.length === 0 && errors.length === 0) errors.push('No data rows found below the header.')
  return { rows, errors, columns }
}
