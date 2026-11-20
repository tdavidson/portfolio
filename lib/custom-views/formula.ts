// Calculated columns for a custom view: arithmetic over a block's own result columns.
//
// A view stores no code, so a formula is not code either. It is a tiny expression language,
// parsed here and evaluated by walking the tree: numbers, result column names, + - * /,
// parentheses, unary minus, and four functions (abs, min, max, round). Nothing else parses, so a
// stored formula can only ever do arithmetic on figures the block already loaded as the viewer.
//
// Division by zero, or a missing figure, gives no value (null) rather than Infinity or 0, so a
// ratio over an empty group shows as a dash instead of a wrong number.
//
// Pure: no imports.

export class FormulaError extends Error {}

export const MAX_FORMULA = 300
export const MAX_COMPUTED = 8
const FUNCTIONS = { abs: 1, min: 2, max: 2, round: 2 } as const
type Fn = keyof typeof FUNCTIONS

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'col'; name: string }
  | { k: 'neg'; e: Expr }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Expr; b: Expr }
  | { k: 'fn'; fn: Fn; args: Expr[] }

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i))
      if (!m) throw new FormulaError(`Unreadable number at "${src.slice(i, i + 8)}".`)
      out.push({ t: 'num', v: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (/[a-z_]/i.test(c)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i))!
      out.push({ t: 'id', v: m[0] })
      i += m[0].length
      continue
    }
    if ('+-*/(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    throw new FormulaError(`"${c}" is not allowed in a formula. Use column names, numbers, + - * / and ( ).`)
  }
  return out
}

/** Parse a formula; every name must be one of `columns` (the block's result columns). */
export function parseFormula(src: unknown, columns: string[]): Expr {
  if (typeof src !== 'string' || !src.trim()) throw new FormulaError('A formula is required.')
  if (src.length > MAX_FORMULA) throw new FormulaError(`A formula can be at most ${MAX_FORMULA} characters.`)
  const tokens = tokenize(src)
  let pos = 0
  const peek = () => tokens[pos]
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected "${v}" in the formula.`)
    pos++
  }

  const primary = (): Expr => {
    const tok = peek()
    if (!tok) throw new FormulaError('The formula ends too soon.')
    if (tok.t === 'num') { pos++; return { k: 'num', v: tok.v } }
    if (tok.t === 'op' && tok.v === '(') { pos++; const e = sum(); expect(')'); return e }
    if (tok.t === 'op' && tok.v === '-') { pos++; return { k: 'neg', e: primary() } }
    if (tok.t === 'id') {
      pos++
      const name = tok.v
      if (isOp('(')) {
        const fn = name.toLowerCase()
        if (!(fn in FUNCTIONS)) throw new FormulaError(`Unknown function "${name}". Use abs, min, max or round.`)
        pos++
        const args: Expr[] = [sum()]
        while (isOp(',')) { pos++; args.push(sum()) }
        expect(')')
        const want = FUNCTIONS[fn as Fn]
        if (fn === 'round' ? args.length < 1 || args.length > 2 : args.length !== want) {
          throw new FormulaError(`${fn} takes ${fn === 'round' ? '1 or 2' : want} argument${want === 1 ? '' : 's'}.`)
        }
        return { k: 'fn', fn: fn as Fn, args }
      }
      if (!columns.includes(name)) throw new FormulaError(`"${name}" is not a column of the result: ${columns.join(', ')}.`)
      return { k: 'col', name }
    }
    throw new FormulaError(`Unexpected "${tok.v}" in the formula.`)
  }
  const product = (): Expr => {
    let e = primary()
    while (isOp('*') || isOp('/')) {
      const op = peek()!.v as '*' | '/'
      pos++
      e = { k: 'bin', op, a: e, b: primary() }
    }
    return e
  }
  function sum(): Expr {
    let e = product()
    while (isOp('+') || isOp('-')) {
      const op = peek()!.v as '+' | '-'
      pos++
      e = { k: 'bin', op, a: e, b: product() }
    }
    return e
  }

  const e = sum()
  if (pos < tokens.length) throw new FormulaError(`Unexpected "${String(tokens[pos].v)}" in the formula.`)
  return e
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export function evaluate(e: Expr, row: Record<string, unknown>): number | null {
  switch (e.k) {
    case 'num': return e.v
    case 'col': return num(row[e.name])
    case 'neg': { const v = evaluate(e.e, row); return v === null ? null : -v }
    case 'bin': {
      const a = evaluate(e.a, row)
      const b = evaluate(e.b, row)
      if (a === null || b === null) return null
      if (e.op === '+') return a + b
      if (e.op === '-') return a - b
      if (e.op === '*') return a * b
      return b === 0 ? null : a / b
    }
    case 'fn': {
      const args = e.args.map(x => evaluate(x, row))
      if (args.some(a => a === null)) return null
      const [a, b] = args as number[]
      if (e.fn === 'abs') return Math.abs(a)
      if (e.fn === 'min') return Math.min(a, b)
      if (e.fn === 'max') return Math.max(a, b)
      const places = Math.max(0, Math.min(6, Math.round(b ?? 0)))
      return Math.round(a * 10 ** places) / 10 ** places
    }
  }
}

export interface Computed { as: string; formula: string }

/** Add each calculated column to every row, in order (a later one may use an earlier one). */
export function applyComputed(rows: Record<string, unknown>[], computed: Computed[], columns: string[]): Record<string, unknown>[] {
  if (!computed.length) return rows
  const known = [...columns]
  const parsed = computed.map(c => {
    const expr = parseFormula(c.formula, known)
    known.push(c.as)
    return { as: c.as, expr }
  })
  return rows.map(r => {
    const out = { ...r }
    for (const c of parsed) out[c.as] = evaluate(c.expr, out)
    return out
  })
}
