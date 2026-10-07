import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * In an EntityScope, `companyIds`/`vehicleNames` of null means "no filter" (an admin), and [] means
 * "sees nothing". `scope.companyIds ?? []` turns the first into the second — every admin would see
 * an empty portfolio — and it reads like a harmless default. It was written six times in one pass.
 * Pin it: never coalesce these fields; write `scope ? scope.companyIds : []` for a missing scope.
 */
function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

describe('entity scope usage', () => {
  it('never coalesces a "no filter" null into "sees nothing"', () => {
    const offenders = ['app', 'lib', 'components'].flatMap(r => files(r))
      .filter(f => /[sS]cope\??\.(companyIds|vehicleNames)\s*\?\?/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
