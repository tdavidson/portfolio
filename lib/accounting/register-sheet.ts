// Reading a capital call or distribution pasted from a spreadsheet: one line per partner, matched
// by name to the entity's partners, with what they have already paid (or been paid) and when.
//
// PURE — the issue form imports it into the browser. Posting the payments a sheet records is
// server-only: lib/accounting/register-import.ts.

const roundCents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface SheetPartner { lpEntityId: string; name: string }

export interface SheetLine {
  lpEntityId: string
  name: string
  /** Called (or distributed) for this partner. */
  amount: number
  /** Paid in (or paid out) so far; 0 = nothing yet. */
  paid: number
  /** When it was paid, if the sheet says; otherwise the register's own date is used. */
  paidOn: string | null
}

export interface ParsedSheet {
  lines: SheetLine[]
  /** Rows whose name matched no partner, as written. */
  unmatched: string[]
  /** What was wrong with the sheet as a whole: no header, no amount column. */
  error: string | null
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/\b(llc|lp|l p|inc|ltd|the)\b/g, ' ').replace(/\s+/g, ' ').trim()

const COLUMNS: Record<'name' | 'amount' | 'paid' | 'paidOn', RegExp> = {
  name: /^(partner|investor|lp|limited partner|name|entity|lp name|investor name)$/,
  amount: /^(amount|called|call|call amount|capital called|this call|distribution|distributed|amount distributed|gross distribution|net distribution|total)$/,
  paid: /^(paid|funded|received|amount paid|amount funded|amount received|paid in|wired)$/,
  paidOn: /^(paid on|funded on|received on|date paid|date funded|date received|payment date|wire date|date)$/,
}

function splitRow(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : ','
  // Commas inside quotes ("Smith, Jane") stay in the cell.
  const out: string[] = []
  let cur = '', quoted = false
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; continue }
    if (ch === sep && !quoted) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map(c => c.trim())
}

/** A money cell: $1,234.56, (1,234.56), 1234 — or null if it is not a number. */
export function parseMoney(cell: string | undefined): number | null {
  if (!cell) return null
  const neg = /^\(.*\)$/.test(cell.trim())
  const n = Number(cell.replace(/[$,()\s]/g, ''))
  return Number.isFinite(n) ? roundCents(neg ? -n : n) : null
}

/** A date cell as YYYY-MM-DD: 2026-10-05, 10/5/2026 or 10/05/26. Null when it is not one. */
export function parseSheetDate(cell: string | undefined): string | null {
  if (!cell) return null
  const t = cell.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t)
  if (!m) return null
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
  const iso = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  const d = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null
}

export function parseRegisterSheet(text: string, partners: SheetPartner[]): ParsedSheet {
  const rows = text.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim()).map(splitRow)
  if (rows.length < 2) return { lines: [], unmatched: [], error: 'Paste a header row and at least one partner.' }
  const header = rows[0].map(h => h.toLowerCase().replace(/[^a-z ]/g, '').trim())
  const col = (k: keyof typeof COLUMNS) => header.findIndex(h => COLUMNS[k].test(h))
  const nameCol = col('name') >= 0 ? col('name') : 0
  const amountCol = col('amount')
  if (amountCol < 0) return { lines: [], unmatched: [], error: 'No amount column. Name one "Amount", "Called" or "Distribution".' }
  const paidCol = col('paid'), paidOnCol = col('paidOn')

  const byName = new Map(partners.map(p => [norm(p.name), p]))
  const merged = new Map<string, SheetLine>()
  const unmatched: string[] = []
  for (const r of rows.slice(1)) {
    const name = r[nameCol] ?? ''
    if (!name || /^total/i.test(name)) continue
    const amount = parseMoney(r[amountCol])
    if (amount == null || amount <= 0) continue
    const partner = byName.get(norm(name))
      // A unique prefix match, so "Northstar Family Office" finds "Northstar Family Office I LLC".
      ?? (() => { const hits = partners.filter(p => norm(p.name).startsWith(norm(name)) || norm(name).startsWith(norm(p.name))); return hits.length === 1 ? hits[0] : undefined })()
    if (!partner) { unmatched.push(name); continue }
    const paid = Math.min(amount, Math.max(0, paidCol >= 0 ? parseMoney(r[paidCol]) ?? 0 : 0))
    const prev = merged.get(partner.lpEntityId)
    merged.set(partner.lpEntityId, {
      lpEntityId: partner.lpEntityId, name: partner.name,
      amount: roundCents((prev?.amount ?? 0) + amount),
      paid: roundCents((prev?.paid ?? 0) + paid),
      paidOn: (paidOnCol >= 0 ? parseSheetDate(r[paidOnCol]) : null) ?? prev?.paidOn ?? null,
    })
  }
  return { lines: [...merged.values()], unmatched, error: null }
}

export interface RegisterPayment { lpEntityId: string; amount: number; date?: string | null }
