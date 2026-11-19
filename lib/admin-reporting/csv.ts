// A partner list from an administrator's export, read as written: one row per partner, a header
// naming the columns. No guessing beyond the header names below, and no AI: the figures are the
// administrator's, so they are taken exactly as the file states them.

const HEADERS: Record<string, string[]> = {
  name: ['name', 'partner', 'partner name', 'investor', 'investor name', 'lp', 'lp name', 'limited partner'],
  external_id: ['id', 'partner id', 'partner uuid', 'investor id', 'external id', 'external_id'],
  commitment: ['commitment', 'commitments', 'total commitment', 'committed capital', 'capital commitment'],
  paid_in: ['paid-in', 'paid in', 'paid_in', 'paid-in capital', 'paid in capital', 'contributions', 'total contributions', 'called capital', 'contributed capital'],
  distributions: ['distributions', 'total distributions', 'distributed'],
  nav: ['nav', 'ending nav', 'net asset value', 'ending capital', 'capital account', 'ending capital balance'],
  receivable: ['receivable', 'call receivable', 'capital call receivable'],
}

/** Split CSV text into rows, honouring quoted fields ("a, b" and doubled quotes). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',' || c === '\t') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim())) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(f => f.trim())) rows.push(row)
  return rows
}

const key = (s: string) => s.toLowerCase().replace(/[()$:*]/g, '').replace(/\s+/g, ' ').trim()

/**
 * The positions in a CSV, shaped for cleanAdminFigures, or what is wrong with the file. Rows whose
 * name reads as a total are skipped: a total is the administrator's sum, not a partner.
 */
export function positionsFromCsv(text: string): Record<string, string>[] | string {
  const rows = parseCsvRows(text)
  if (rows.length < 2) return 'The file needs a header row and at least one partner.'
  const header = rows[0].map(key)
  const col: Record<string, number> = {}
  for (const [field, names] of Object.entries(HEADERS)) {
    const i = header.findIndex(h => names.includes(h))
    if (i >= 0) col[field] = i
  }
  const missing = ['name', 'commitment', 'paid_in', 'distributions', 'nav'].filter(f => col[f] === undefined)
  if (missing.length) {
    return `The header has no column for ${missing.map(m => m.replace('_', '-')).join(', ')}. ` +
      'Name the columns Name, Commitment, Paid-in, Distributions and NAV (Partner ID and Receivable are optional).'
  }
  const out: Record<string, string>[] = []
  for (const r of rows.slice(1)) {
    const name = (r[col.name] ?? '').trim()
    if (!name || /^(grand )?totals?\b/i.test(name)) continue
    const entry: Record<string, string> = { name }
    for (const field of ['external_id', 'commitment', 'paid_in', 'distributions', 'nav', 'receivable']) {
      if (col[field] !== undefined) entry[field] = (r[col[field]] ?? '').trim()
    }
    if (!entry.external_id) delete entry.external_id
    out.push(entry)
  }
  if (out.length === 0) return 'The file has no partner rows.'
  return out
}
