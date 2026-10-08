import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A fund holding's NAV reaches the ledger through ONE writer, lib/portfolio/fof-nav.ts
 * (plans/spec-ledger-one-writer.md §4). The quarter-wide grid, its confirm loop, the period-end
 * mark booker and the extractor route were second ways in; they stay gone.
 */
function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

describe('second NAV writers', () => {
  it('the routes are deleted', () => {
    for (const r of ['fof-marks', 'fof-grid', 'fof-grid/confirm', 'fof-extract']) {
      expect(existsSync(`app/api/accounting/${r}/route.ts`), r).toBe(false)
    }
  })

  it('nothing calls them', () => {
    const callers = ['app', 'components', 'lib'].flatMap(d => files(d))
      .filter(f => /\/api\/accounting\/fof-(marks|grid|extract)/.test(readFileSync(f, 'utf8')))
    expect(callers).toEqual([])
  })

  it('only fof-nav writes NAV statements', () => {
    const writers = ['app', 'components', 'lib'].flatMap(d => files(d))
      .filter(f => !/\.test\.tsx?$/.test(f) && f !== join('lib', 'portfolio', 'fof-nav.ts'))
      .filter(f => /from\(\s*['"]fund_nav_statements['"]\)[\s\S]{0,80}\.(insert|upsert)\(/.test(readFileSync(f, 'utf8')))
    expect(writers).toEqual([])
  })
})
