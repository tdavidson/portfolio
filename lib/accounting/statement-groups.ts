// Folding a statement's detail lines into collapsible groups.
//
// A fund's chart keeps one sub-account per holding (and per partner, per counterparty) under a
// parent code: `1100-<company>` "Investment — <company>", `4000-<company>` "Realized gain —
// <company>". Shown flat, a twenty-company fund's balance sheet is twenty investment lines before the
// first liability. The statements fold each run of siblings into one line, carrying their sum, that
// the reader opens when they want the per-company figures.

export interface CodedLine {
  code?: string | null
  name: string
}

export type GroupedLine<T> =
  | { kind: 'row'; row: T }
  | { kind: 'group'; key: string; code: string; name: string; rows: T[] }

/** `1100-abc` → `1100`. A code without a suffix has no parent. */
export function parentCode(code: string | null | undefined): string | null {
  if (!code) return null
  const i = code.indexOf('-')
  return i > 0 ? code.slice(0, i) : null
}

/** "Investment — Acme, Inc." → "Investment". */
function baseName(name: string): string {
  const i = name.indexOf(' — ')
  return i > 0 ? name.slice(0, i) : name
}

/**
 * Group sub-accounts that share a parent code, in the order the lines came. A group forms only when
 * at least `minSize` sub-accounts share the parent; fewer stay as plain lines, since folding one line
 * into one line hides nothing. A line carrying the parent code itself joins its group, first, and
 * names it; otherwise the group takes the name the sub-accounts share before " — ".
 */
export function groupSubAccounts<T>(rows: T[], get: (row: T) => CodedLine, minSize = 2): GroupedLine<T>[] {
  const children = new Map<string, T[]>()
  for (const r of rows) {
    const p = parentCode(get(r).code)
    if (p) children.set(p, [...(children.get(p) ?? []), r])
  }
  const grouped = new Set([...children].filter(([, kids]) => kids.length >= minSize).map(([p]) => p))
  const parentRow = new Map<string, T>()
  for (const r of rows) {
    const code = get(r).code
    if (code && grouped.has(code)) parentRow.set(code, r)
  }

  const out: GroupedLine<T>[] = []
  const placed = new Set<string>()
  for (const r of rows) {
    const code = get(r).code ?? null
    const p = code && grouped.has(code) ? code : parentCode(code)
    if (!p || !grouped.has(p)) { out.push({ kind: 'row', row: r }); continue }
    if (placed.has(p)) continue
    placed.add(p)
    const own = parentRow.get(p)
    const kids = children.get(p)!
    const bases = new Set(kids.map(k => baseName(get(k).name)))
    const name = own ? get(own).name : bases.size === 1 ? [...bases][0] : p
    out.push({ kind: 'group', key: p, code: p, name, rows: own ? [own, ...kids] : kids })
  }
  return out
}

export interface Leg {
  name: string
  amount: number
}

export interface LegSummary {
  side: 'Dr' | 'Cr'
  name: string
  count: number
}

/**
 * An entry's legs, one line per side and account kind: a capital call credits every partner's
 * capital sub-account, and listing eighty of them by name buries the entry. "Cr Partners' capital"
 * with a count says the same thing; a kind with one leg keeps its full name.
 */
export function summarizeLegs(legs: Leg[]): LegSummary[] {
  const out: (LegSummary & { full: string })[] = []
  for (const l of legs) {
    const side = l.amount > 0 ? 'Dr' : 'Cr'
    const name = baseName(l.name)
    const hit = out.find(o => o.side === side && o.name === name)
    if (hit) hit.count += 1
    else out.push({ side, name, count: 1, full: l.name })
  }
  return out.map(({ side, name, count, full }) => ({ side, name: count === 1 ? full : name, count }))
}
