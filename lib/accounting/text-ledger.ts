// Plain-text double-entry — the authoring surface. Entries are written and read
// as plain text; Postgres is just the implementation store. This module is the
// round-trip: serialize the books to text, and parse authored text back into
// balanced entries (the API resolves account names → chart accounts and
// persists). A posting's amount is simply the signed change to the account —
// which is exactly our debit-positive/credit-negative posting sign, so no sign
// flipping is needed either direction.

import { roundCents } from './ledger'
import type { Account, AccountType, Posting } from './types'

const ROOT: Record<AccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses',
}

/** An account-name component: capitalized words joined by dashes. */
function slug(name: string): string {
  const s = (name || '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-')
  return s || 'Acct'
}

/**
 * Hierarchical account name for a chart account: `Root:Slug:Code`. The last
 * component is the chart code, so the parser can resolve it back unambiguously;
 * the middle slug keeps it human-readable.
 */
export function textAccountName(account: Account): string {
  return `${ROOT[account.type]}:${slug(account.name)}:${account.code}`
}

/** The chart code encoded as the last component of an account name. */
export function codeFromAccountName(name: string): string {
  const parts = name.split(':')
  return parts[parts.length - 1]
}

export interface TextPostingInput {
  accountId: string
  amount: number
  currency: string
}
export interface TextEntryInput {
  entryDate: string
  memo?: string | null
  sourceType?: string | null
  sourceRef?: string | null
  status?: string
  postings: TextPostingInput[]
}

/** Serialize a vehicle's books to plain text (open directives + entries). */
export function serializeLedger(accounts: Account[], entries: TextEntryInput[]): string {
  const byId = new Map(accounts.map(a => [a.id, a]))
  const lines: string[] = []

  const dated = entries.filter(e => e.entryDate).sort((a, b) => a.entryDate.localeCompare(b.entryDate))
  const firstDate = dated[0]?.entryDate
  const used = new Set<string>()
  for (const e of dated) for (const p of e.postings) if (byId.has(p.accountId)) used.add(p.accountId)
  if (firstDate && used.size) {
    for (const id of Array.from(used)) lines.push(`${firstDate} open ${textAccountName(byId.get(id)!)}`)
    lines.push('')
  }

  for (const e of dated) {
    const flag = e.status === 'posted' ? '*' : '!'
    const narration = (e.memo || e.sourceType || 'Entry').replace(/"/g, "'")
    lines.push(`${e.entryDate} ${flag} "${narration}"`)
    if (e.sourceType) lines.push(`  source: "${e.sourceType}"`)
    // What produced the entry (txn:<id>, qb:<hash>, …). Re-importing an exported ledger must not
    // book these a second time — postLedgerText refuses an entry whose ref is already live.
    if (e.sourceRef) lines.push(`  ref: "${e.sourceRef}"`)
    for (const p of e.postings) {
      const acct = byId.get(p.accountId)
      const name = acct ? textAccountName(acct) : `Equity:Unknown:${p.accountId.slice(0, 8)}`
      lines.push(`  ${name}  ${roundCents(p.amount).toFixed(2)} ${p.currency}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export interface ParsedTextPosting {
  account: string
  amount: number | null // null = elided (auto-balance)
  currency: string
}
export interface ParsedTextEntry {
  date: string
  flag: string // '*' posted, '!' draft
  narration: string
  sourceType?: string
  ref?: string
  postings: ParsedTextPosting[]
}
export interface ParseTextResult {
  entries: ParsedTextEntry[]
  errors: string[]
}

/**
 * Resolve parsed postings against a chart: by full text name (`Root:Slug:Code`) or by the bare
 * code the last component carries. A per-partner account's `lpEntityId` rides onto the posting,
 * so an entry authored in text attributes to the partner exactly as one typed in the modal does.
 * Unknown names are reported, never guessed.
 */
export function resolvePostingAccounts(
  accounts: Account[],
  postings: ParsedTextPosting[],
): { postings: Posting[]; unknown: string[] } {
  const byName = new Map(accounts.map(a => [textAccountName(a), a]))
  const byCode = new Map(accounts.map(a => [a.code, a]))
  const out: Posting[] = []
  const unknown: string[] = []
  for (const p of postings) {
    const acct = byName.get(p.account) ?? byCode.get(codeFromAccountName(p.account)) ?? null
    if (!acct) { unknown.push(p.account); continue }
    out.push({ accountId: acct.id, amount: p.amount ?? 0, currency: p.currency, lpEntityId: acct.lpEntityId ?? null })
  }
  return { postings: out, unknown }
}

const HEADER_RE = /^(\d{4}-\d{2}-\d{2})\s+([*!])\s+(.*)$/
const META_RE = /^\s+([a-z][A-Za-z0-9_-]*):\s+"?([^"]*)"?\s*$/
const POSTING_RE = /^\s+([A-Za-z][A-Za-z0-9:_-]+)\s+(-?[\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?\s*$/
const POSTING_ELIDED_RE = /^\s+([A-Za-z][A-Za-z0-9:_-]+)\s*$/

function narrationOf(rest: string): string {
  const quoted = Array.from(rest.matchAll(/"([^"]*)"/g)).map(m => m[1])
  if (quoted.length) return quoted[quoted.length - 1]
  return rest.trim()
}

/**
 * Parse plain-text double-entry into balanced entries. Supports amount elision (one
 * posting per entry may omit its amount; it's inferred as the negation of the
 * rest). Comments (`;`) and directives (open/close/etc.) are ignored. Malformed
 * or unbalanced entries are reported, not silently dropped.
 */
export function parseLedgerText(text: string): ParseTextResult {
  const rawLines = text.split(/\r?\n/)
  const entries: ParsedTextEntry[] = []
  const errors: string[] = []
  let cur: ParsedTextEntry | null = null
  let curLine = 0

  const finish = () => {
    if (!cur) return
    // Resolve elision + validate balance per currency.
    const byCur = new Map<string, { sum: number; elided: ParsedTextPosting[] }>()
    for (const p of cur.postings) {
      const g = byCur.get(p.currency) ?? { sum: 0, elided: [] }
      if (p.amount === null) g.elided.push(p)
      else g.sum = roundCents(g.sum + p.amount)
      byCur.set(p.currency, g)
    }
    for (const [ccy, g] of Array.from(byCur.entries())) {
      if (g.elided.length > 1) { errors.push(`Entry ${cur.date}: more than one posting without an amount (${ccy})`); cur = null; return }
      if (g.elided.length === 1) g.elided[0].amount = roundCents(-g.sum)
      else if (g.sum !== 0) { errors.push(`Entry ${cur.date} does not balance (${ccy}: ${g.sum > 0 ? '+' : ''}${g.sum})`); cur = null; return }
    }
    if (cur.postings.length < 2) { errors.push(`Entry ${cur.date}: an entry needs at least two postings`); cur = null; return }
    entries.push(cur)
    cur = null
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    curLine = i + 1
    if (!line.trim() || line.trimStart().startsWith(';')) { if (!line.trim()) finish(); continue }

    const header = line.match(HEADER_RE)
    if (header) {
      finish()
      cur = { date: header[1], flag: header[2], narration: narrationOf(header[3]), postings: [] }
      continue
    }

    if (/^\s/.test(line)) {
      if (!cur) continue
      // Metadata (lowercase key: value) — capture `source` for the roll-forward.
      const meta = line.match(META_RE)
      if (meta) { if (meta[1] === 'source') cur.sourceType = meta[2]; else if (meta[1] === 'ref') cur.ref = meta[2]; continue }
      const m = line.match(POSTING_RE)
      if (m) { cur.postings.push({ account: m[1], amount: roundCents(Number(m[2].replace(/,/g, ''))), currency: m[3] ?? 'USD' }); continue }
      const em = line.match(POSTING_ELIDED_RE)
      if (em) { cur.postings.push({ account: em[1], amount: null, currency: 'USD' }); continue }
      // Unindented directives at column 0 (open/close/option/…) fall through and are ignored.
      errors.push(`Line ${curLine}: could not parse posting "${line.trim()}"`)
      continue
    }
    // Non-indented, non-header line (open/close/plugin/option/commodity) — ignore.
  }
  finish()

  return { entries, errors }
}
