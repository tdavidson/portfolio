//
// An in-memory stand-in for the Supabase admin client, for tests whose flow crosses several
// tables (post an entry, adopt its transactions, link a bank row). Implements the query-builder
// subset lib/accounting uses — select (with `journal_postings(...)` embedded under
// `journal_entries`), eq/neq/in/is/not-is/like/gt/gte/lt/lte, order, range, limit, insert, upsert
// (ignoreDuplicates), update, delete, maybeSingle, single, count+head — over plain arrays.
// Not a database: no RLS, no triggers, no joins beyond the one embed.

export type Row = Record<string, any>
type Op = 'insert' | 'update' | 'delete'
type FailOp = Op | 'select'

const EMBEDS: Record<string, Record<string, string>> = {
  journal_entries: { journal_postings: 'journal_entry_id' },
}

export interface MemoryAdminOptions {
  unique?: { table: string; key: (r: Row) => string | null }[]
  /** Runs before every write, with the live tables — lets a test play a concurrent request. */
  before?: (table: string, op: Op, payload: any, tables: Record<string, Row[]>) => void
}

export function memoryAdmin(seed: Record<string, Row[]> = {}, opts: MemoryAdminOptions = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map(r => ({ ...r }))
  let serial = 0
  const failures: { table: string; op: FailOp; message: string }[] = []
  const failNext = (table: string, op: FailOp, message: string) => { failures.push({ table, op, message }) }
  const takeFailure = (table: string, op: FailOp) => {
    const i = failures.findIndex(f => f.table === table && f.op === op)
    return i < 0 ? null : failures.splice(i, 1)[0].message
  }
  const violates = (table: string, row: Row, self?: Row) => (opts.unique ?? []).some(u => {
    if (u.table !== table) return false
    const k = u.key(row)
    return k != null && (tables[table] ?? []).some(r => r !== self && u.key(r) === k)
  })
  const like = (v: unknown, pattern: string) => new RegExp(
    '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$',
  ).test(String(v ?? ''))
  const UNIQUE = { message: 'duplicate key value violates unique constraint' }

  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = []
    let mode: 'select' | Op = 'select'
    let payload: any = null
    let ignoreDuplicates = false
    let cols = '*'
    let returning = false
    let head = false
    let counting = false
    const order: { key: string; asc: boolean }[] = []
    let start = 0
    let end = Infinity

    const embed = (row: Row) => {
      const out = { ...row }
      for (const [child, fk] of Object.entries(EMBEDS[table] ?? {})) {
        if (cols.includes(`${child}(`)) out[child] = (tables[child] ?? []).filter(c => c[fk] === row.id).map(c => ({ ...c }))
      }
      return out
    }

    const run = (): { data: any; error: any; count?: number | null } => {
      tables[table] ??= []
      if (mode === 'select') {
        const selectFailure = takeFailure(table, 'select')
        if (selectFailure) return { data: null, error: { message: selectFailure }, count: null }
        const matched = tables[table].filter(r => filters.every(f => f(r)))
        const rows = [...matched]
        for (const o of [...order].reverse()) {
          rows.sort((a, b) => (a[o.key] < b[o.key] ? -1 : a[o.key] > b[o.key] ? 1 : 0) * (o.asc ? 1 : -1))
        }
        const page = rows.slice(start, end === Infinity ? undefined : end + 1)
        return { data: head ? null : page.map(embed), error: null, count: counting ? rows.length : null }
      }
      // Ruling R1: call before hook BEFORE computing matched for write modes
      opts.before?.(table, mode, payload, tables)
      const failure = takeFailure(table, mode)
      if (failure) return { data: null, error: { message: failure } }
      // Now compute matched after before hook, so concurrent writes affect filtering
      const matched = tables[table].filter(r => filters.every(f => f(r)))
      if (mode === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `${table}-${++serial}`, ...r }))
        const kept: Row[] = []
        for (const r of list) {
          if (violates(table, r) || kept.some(k => (opts.unique ?? []).some(u => u.table === table && u.key(k) != null && u.key(k) === u.key(r)))) {
            if (ignoreDuplicates) continue
            return { data: null, error: UNIQUE }
          }
          kept.push(r)
        }
        tables[table].push(...kept)
        return { data: returning ? kept.map(r => ({ ...r })) : null, error: null }
      }
      if (mode === 'update') {
        for (const r of matched) if (violates(table, { ...r, ...payload }, r)) return { data: null, error: UNIQUE }
        for (const r of matched) Object.assign(r, payload)
        return { data: returning ? matched.map(r => ({ ...r })) : null, error: null }
      }
      tables[table] = tables[table].filter(r => !matched.includes(r))
      return { data: returning ? matched : null, error: null }
    }

    const q: any = {
      select: (c = '*', o?: { count?: string; head?: boolean }) => {
        if (mode === 'select') cols = c
        else returning = true
        counting = !!o?.count
        head = !!o?.head
        return q
      },
      insert: (rows: any) => { mode = 'insert'; payload = rows; return q },
      upsert: (rows: any, o?: { ignoreDuplicates?: boolean }) => { mode = 'insert'; payload = rows; ignoreDuplicates = !!o?.ignoreDuplicates; return q },
      update: (v: Row) => { mode = 'update'; payload = v; return q },
      delete: () => { mode = 'delete'; return q },
      eq: (k: string, v: unknown) => { filters.push(r => r[k] === v); return q },
      neq: (k: string, v: unknown) => { filters.push(r => r[k] !== v); return q },
      in: (k: string, vs: unknown[]) => { filters.push(r => vs.includes(r[k])); return q },
      is: (k: string, v: unknown) => { filters.push(r => (r[k] ?? null) === v); return q },
      not: (k: string, op: string, v: unknown) => {
        if (op !== 'is') throw new Error(`memoryAdmin: not(${op}) unsupported`)
        filters.push(r => (r[k] ?? null) !== v); return q
      },
      like: (k: string, p: string) => { filters.push(r => like(r[k], p)); return q },
      gt: (k: string, v: any) => { filters.push(r => r[k] > v); return q },
      gte: (k: string, v: any) => { filters.push(r => r[k] >= v); return q },
      lt: (k: string, v: any) => { filters.push(r => r[k] < v); return q },
      lte: (k: string, v: any) => { filters.push(r => r[k] <= v); return q },
      order: (k: string, o?: { ascending?: boolean }) => { order.push({ key: k, asc: o?.ascending !== false }); return q },
      range: (a: number, b: number) => { start = a; end = b; return q },
      limit: (n: number) => { end = start + n - 1; return q },
      maybeSingle: async () => { const r = run(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data } },
      single: async () => {
        const r = run()
        const d = Array.isArray(r.data) ? r.data[0] : r.data
        return d ? { ...r, data: d } : { data: null, error: r.error ?? { message: 'JSON object requested, multiple (or no) rows returned' } }
      },
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    }
    return q
  }

  const admin = {
    from,
    rpc: async (name: string) => ({ data: null, error: { message: `memoryAdmin: rpc ${name} unsupported` } }),
  }
  return { admin: admin as any, tables, failNext }
}
