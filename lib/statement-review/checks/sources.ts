// Figures found in the documents: every figure read out of the administrator's documents is printed
// on the page its citation names. A figure that isn't anywhere in the document was misread or made
// up, and every other check would be reasoning about it, so it is a warning of its own. A figure
// printed on another page than the one cited is information. Runs only when the package was read
// from documents whose text the run has.

import { fieldValue, fmt, FIELD_LABELS } from '../compare'
import type { CapitalFigures, Citation, Finding, StatementPackage } from '../types'
import { CAPITAL_FIELDS, ALLOCATION_KEYS } from '../types'
import type { Check } from './shared'

const MAX_FINDINGS = 40

/** A document's text split into pages by its [Page N] markers. Text before the first marker is page 0. */
export function pagesOf(text: string): Map<number, string> {
  const pages = new Map<number, string>()
  const re = /\[Page (\d+)[^\]]*\]/g
  let last = 0
  let page = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    pages.set(page, (pages.get(page) ?? '') + text.slice(last, m.index))
    page = Number(m[1])
    last = m.index + m[0].length
  }
  pages.set(page, (pages.get(page) ?? '') + text.slice(last))
  return pages
}

/** The amounts printed in some text, as magnitudes, with whether each was printed with decimals. */
export function printedAmounts(text: string): { value: number; decimals: boolean }[] {
  const out: { value: number; decimals: boolean }[] = []
  const re = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const raw = m[0]
    out.push({ value: Number(raw.replace(/,/g, '')), decimals: raw.includes('.') })
  }
  return out
}

/** Whether `value` is printed in the text: to the cent, or to the dollar where the text prints whole dollars. */
export function isPrinted(value: number, text: string): boolean {
  const v = Math.abs(value)
  return printedAmounts(text).some(a => (a.decimals ? Math.abs(a.value - v) <= 0.005 : Math.abs(a.value - v) < 0.5))
}

interface Cited { subject: Finding['subject']; what: string; value: number; cite: Citation }

/** Every cited figure in the package, and how many figures have no citation. */
export function citedFigures(pkg: StatementPackage): { cited: Cited[]; uncited: number } {
  const cited: Cited[] = []
  let uncited = 0
  const capital = (f: CapitalFigures, subject: Finding['subject'], whose: string) => {
    const fields = [...CAPITAL_FIELDS, ...ALLOCATION_KEYS.map(k => `allocations.${k}`), 'allocations.total']
    for (const field of fields) {
      const value = fieldValue(f, field)
      if (value == null) continue
      const cite = f.cite?.[field]
      if (!cite) { uncited++; continue }
      cited.push({ subject, what: `${whose} ${FIELD_LABELS[field] ?? field}`, value, cite })
    }
  }
  for (const p of pkg.partners ?? []) capital(p, { kind: 'partner', ...(p.lpEntityId ? { id: p.lpEntityId } : {}), label: p.name }, `${p.name}'s`)
  const f = pkg.fund
  if (f?.partnerTotals) capital(f.partnerTotals, { kind: 'fund', label: 'Partner schedule total' }, "The partner schedule's total")
  if (f?.partnersCapital) capital(f.partnersCapital, { kind: 'fund', label: "Fund partners' capital" }, "The fund's")
  const statement = (label: string, s: Record<string, unknown> | undefined, keys: string[], names: Record<string, string>) => {
    if (!s) return
    const cites = (s.cite ?? {}) as Record<string, Citation>
    for (const k of keys) {
      const value = s[k]
      if (typeof value !== 'number') continue
      if (!cites[k]) { uncited++; continue }
      cited.push({ subject: { kind: 'fund', label }, what: names[k], value, cite: cites[k] })
    }
  }
  statement('Balance sheet', f?.balanceSheet as any, ['totalAssets', 'totalLiabilities', 'partnersCapital', 'totalLiabilitiesAndCapital'], {
    totalAssets: 'Total assets', totalLiabilities: 'Total liabilities', partnersCapital: "Partners' capital", totalLiabilitiesAndCapital: "Total liabilities and partners' capital",
  })
  statement('Statement of operations', f?.operations as any, ['netIncome'], { netIncome: 'Net income' })
  statement('Schedule of investments', f?.soi as any, ['cost', 'fairValue'], { cost: 'Total cost', fairValue: 'Total fair value' })
  const lines = (label: string, list: { label: string; amount: number; cite?: Citation }[] | undefined) => {
    for (const l of list ?? []) {
      if (!l.cite) { uncited++; continue }
      cited.push({ subject: { kind: 'fund', label }, what: l.label, value: l.amount, cite: l.cite })
    }
  }
  lines('Balance sheet', f?.balanceSheet?.assets)
  lines('Balance sheet', f?.balanceSheet?.liabilities)
  lines('Statement of operations', f?.operations?.lines)
  for (const h of pkg.holdings ?? []) {
    for (const [k, label] of [['cost', 'cost'], ['fairValue', 'fair value']] as const) {
      const value = h[k]
      if (value == null) continue
      if (!h.cite) { uncited++; continue }
      cited.push({ subject: { kind: 'holding', label: h.name }, what: `${h.name}'s ${label}`, value, cite: h.cite })
    }
  }
  for (const c of pkg.cash ?? []) {
    if (!c.cite) { uncited++; continue }
    cited.push({ subject: { kind: 'account', label: c.account }, what: `${c.account} cash`, value: c.balance, cite: c.cite })
  }
  return { cited, uncited }
}

export const sources: Check = ({ pkg, sources: docs }) => {
  const findings: Finding[] = []
  if (!docs?.length) {
    return { outcome: { check: 'sources', ran: false, compared: 0, note: 'The figures were not read from documents in this run.' }, findings }
  }
  const byName = new Map(docs.map(d => [d.name.trim().toLowerCase(), pagesOf(d.text)]))
  const { cited, uncited } = citedFigures(pkg)
  let compared = 0
  let over = 0
  const add = (f: Finding) => { if (findings.length < MAX_FINDINGS) findings.push(f); else over++ }
  for (const c of cited) {
    // A zero is often printed as a dash.
    if (Math.abs(c.value) < 0.005) continue
    compared++
    const pages = byName.get(c.cite.document.trim().toLowerCase())
    const base = { check: 'sources' as const, subject: c.subject, stated: Math.round(c.value * 100) / 100, cites: [c.cite], status: 'open' as const }
    if (!pages) {
      add({ ...base, severity: 'warning', message: `${c.what} (${fmt(c.value)}) cites "${c.cite.document}", which isn't one of the documents read.` })
      continue
    }
    const onPage = c.cite.page != null ? pages.get(c.cite.page) : undefined
    if (onPage != null && isPrinted(c.value, onPage)) continue
    const elsewhere = [...pages.entries()].find(([, text]) => isPrinted(c.value, text))
    if (elsewhere && (c.cite.page == null || elsewhere[0] !== c.cite.page)) {
      if (c.cite.page == null) continue
      add({ ...base, severity: 'info', message: `${c.what} (${fmt(c.value)}) is printed on page ${elsewhere[0]} of ${c.cite.document}, not page ${c.cite.page} as cited.` })
      continue
    }
    add({ ...base, severity: 'warning', message: `${c.what} (${fmt(c.value)}) isn't printed anywhere in ${c.cite.document}. Check the figure against the document.` })
  }
  const notes = [
    uncited ? `${uncited} figure${uncited === 1 ? ' has' : 's have'} no citation, so ${uncited === 1 ? 'it' : 'they'} couldn't be found in the documents.` : '',
    over ? `${over} more figure${over === 1 ? '' : 's'} weren't found; only the first ${MAX_FINDINGS} are listed.` : '',
  ].filter(Boolean).join(' ')
  return { outcome: { check: 'sources', ran: compared > 0, compared, ...(notes ? { note: notes } : {}) }, findings }
}
