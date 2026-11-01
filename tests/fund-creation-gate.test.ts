import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

describe('who may start a fund', () => {
  it('the onboarding route refuses an LP or an existing member before creating one, as the consent screen does', () => {
    const route = src('app/api/onboarding/fund/route.ts')
    const refused = route.indexOf('await fundCreationRefusal(admin as any, user.id)')
    expect(refused).toBeGreaterThan(-1)
    expect(refused).toBeLessThan(route.indexOf('await createFund('))
  })

  it('the signup allow-list takes no wildcard on a personal email provider', () => {
    const route = src('app/api/settings/whitelist/route.ts')
    expect(route).toMatch(/isWildcard && !claimableEmailDomain\(/)
  })
})
