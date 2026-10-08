import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The accounting "Setup" step is gone: a vehicle's chart is seeded when it is created (or on first
 * look), and investment value is recorded on the company, not revalued from the journal. A message
 * telling someone to "seed the chart", "run Sync accounts" or use "the Setup page" sends them to a
 * control that does not exist.
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

describe('no copy points at the removed accounting setup', () => {
  it.each([
    ['Sync accounts', /Sync accounts/],
    ['seed the chart … first', /seed the chart[^\n]*first/i],
    ['the Setup page', /Setup page/],
    ['Revalue investment', /Revalue investment/],
    ['a draft waiting for its bank match', /waits? (as a draft )?for its bank match/],
  ])('%s', (_label, pattern) => {
    const offenders = ['app', 'components', 'lib'].flatMap(r => sources(r)).filter(f => pattern.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
