import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pageEntries } from '@/lib/nav/palette'

/**
 * Fund holdings live on /companies/[id] (plans/spec-ledger-one-writer.md §6); /fund-holdings is
 * gone, as /portfolio went before it. A link left pointing at it is a 404 in someone's nav.
 * The fund-holding APIs (/api/portfolio/fund-holdings/*) stay — they are the register's.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e === 'dist' || e === 'data' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

describe('/fund-holdings is gone', () => {
  it('has no page', () => {
    expect(existsSync('app/(app)/fund-holdings')).toBe(false)
  })

  it('nothing links to it', () => {
    const page = /(?<!api\/portfolio)\/fund-holdings\b/
    const offenders = ['app', 'components', 'lib', 'demo-widget']
      .flatMap(r => sources(r))
      .filter(f => page.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('is not in the command palette, even once the fund holds a fund', () => {
    const hrefs = pageEntries(true, () => 'write', { fofActive: true }).map(e => e.href)
    expect(hrefs).not.toContain('/fund-holdings')
    expect(hrefs).toContain('/investments')
  })
})
