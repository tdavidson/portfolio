import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { validatePostings } from './persist'

const seed = () => memoryAdmin({
  chart_of_accounts: [
    { id: 'a1', fund_id: 'f', vehicle_id: 'v1' }, { id: 'a2', fund_id: 'f', vehicle_id: 'v1' },
    { id: 'b1', fund_id: 'f', vehicle_id: 'v2' },
  ],
  lp_entities: [{ id: 'p1', fund_id: 'f' }, { id: 'q1', fund_id: 'other' }],
}).admin

describe('validatePostings — every leg on this entity\'s accounts, every partner in this fund', () => {
  it('passes postings on the entity\'s own accounts and partners', async () => {
    expect(await validatePostings(seed(), 'f', 'v1', 'Fund I', [{ accountId: 'a1', lpEntityId: 'p1' }, { accountId: 'a2' }])).toBeNull()
  })

  it('refuses a leg on another entity\'s account', async () => {
    expect(await validatePostings(seed(), 'f', 'v1', 'Fund I', [{ accountId: 'a1' }, { accountId: 'b1' }])).toMatch(/doesn't belong to Fund I: b1/)
  })

  it('refuses a partner from another fund', async () => {
    expect(await validatePostings(seed(), 'f', 'v1', 'Fund I', [{ accountId: 'a1', lpEntityId: 'q1' }])).toMatch(/isn't in this fund: q1/)
  })

  it('editing a draft runs the same checks before writing postings', () => {
    const src = readFileSync(join(__dirname, '../../app/api/accounting/journal/route.ts'), 'utf8')
    const put = src.slice(src.indexOf('export async function PUT'), src.indexOf('export async function POST'))
    expect(put.indexOf('validatePostings(')).toBeGreaterThan(-1)
    expect(put.indexOf('validatePostings(')).toBeLessThan(put.indexOf(".from('journal_postings' as any).insert("))
  })
})
