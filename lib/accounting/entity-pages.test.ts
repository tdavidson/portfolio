import { describe, expect, it } from 'vitest'
import { entityBase, entityPagesFor } from './entity-pages'

const all = () => true
const slugs = (kind: string | null, canOpen: Parameters<typeof entityPagesFor>[1] = all) =>
  entityPagesFor(kind, canOpen).map(s => s.href.replace('/funds/', ''))

describe('entity index links', () => {
  it('lists a fund’s pages, without the ones only a management company has', () => {
    const fund = slugs('fund')
    expect(fund).toContain('journal')
    expect(fund).toContain('forecast')
    expect(fund).not.toContain('receipts')
    expect(fund).not.toContain('partnership-expenses')
  })

  it('treats a legacy vehicle with no kind as a fund', () => {
    expect(slugs(null)).toEqual(slugs('fund'))
  })

  it('follows the kind: a management company has receipts and no capital accounts', () => {
    const manco = slugs('manco')
    expect(manco).toContain('receipts')
    expect(manco).not.toContain('capital-accounts')
    expect(manco).not.toContain('schedule-of-investments')
  })

  it('leaves out a page the caller cannot open', () => {
    const noLpCapital = slugs('fund', domain => domain !== 'lp_capital')
    expect(noLpCapital).not.toContain('capital-accounts')
    expect(noLpCapital).toContain('journal')
  })

  it('addresses an entity by id, or a legacy one by its name', () => {
    expect(entityBase({ id: 'abc', name: 'Example Fund I' })).toBe('/funds/abc')
    expect(entityBase({ id: null, name: 'Example Fund I' })).toBe('/funds/Example%20Fund%20I')
  })
})
