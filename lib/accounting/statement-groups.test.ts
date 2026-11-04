import { describe, expect, it } from 'vitest'
import { groupSubAccounts, parentCode, summarizeLegs } from './statement-groups'

const row = (code: string, name: string) => ({ code, name })
const id = (r: { code: string; name: string }) => r

describe('parentCode', () => {
  it('reads the code before the first dash', () => {
    expect(parentCode('1100-ab12')).toBe('1100')
    expect(parentCode('1000')).toBeNull()
    expect(parentCode('')).toBeNull()
    expect(parentCode(null)).toBeNull()
  })
})

describe('groupSubAccounts', () => {
  it('folds sibling sub-accounts into one group where the first one stood', () => {
    const out = groupSubAccounts([
      row('1000', 'Cash'),
      row('1100-a', 'Investment — Acme, Inc.'),
      row('1100-b', 'Investment — Northwind LLC'),
      row('1200', 'Prepaid expenses'),
    ], id)
    expect(out.map(o => o.kind)).toEqual(['row', 'group', 'row'])
    const g = out[1]
    expect(g.kind === 'group' && { code: g.code, name: g.name, n: g.rows.length }).toEqual({ code: '1100', name: 'Investment', n: 2 })
  })

  it('leaves a lone sub-account as a plain line', () => {
    const out = groupSubAccounts([row('1000', 'Cash'), row('1100-a', 'Investment — Acme, Inc.')], id)
    expect(out.every(o => o.kind === 'row')).toBe(true)
  })

  it('takes the parent line into its group and its name', () => {
    const out = groupSubAccounts([
      row('1100-a', 'Investment — Acme, Inc.'),
      row('1100', 'Investments at cost'),
      row('1100-b', 'Investment — Northwind LLC'),
    ], id)
    expect(out).toHaveLength(1)
    const g = out[0]
    expect(g.kind === 'group' && g.name).toBe('Investments at cost')
    expect(g.kind === 'group' && g.rows.map(r => r.code)).toEqual(['1100', '1100-a', '1100-b'])
  })

  it('names a group of mixed sub-accounts by its code', () => {
    const out = groupSubAccounts([row('1900-a', 'Due from Example Fund I'), row('1900-b', 'Loan to Example GP')], id)
    expect(out[0].kind === 'group' && out[0].name).toBe('1900')
  })
})

describe('summarizeLegs', () => {
  it('counts legs of one kind on one side and keeps lone legs whole', () => {
    expect(summarizeLegs([
      { name: "Partners' capital — Jane Doe", amount: -100 },
      { name: "Partners' capital — Acme Holdings LLC", amount: -200 },
      { name: 'Due from LPs', amount: 300 },
      { name: "Partners' capital — Example GP", amount: 50 },
    ])).toEqual([
      { side: 'Cr', name: "Partners' capital", count: 2 },
      { side: 'Dr', name: 'Due from LPs', count: 1 },
      { side: 'Dr', name: "Partners' capital — Example GP", count: 1 },
    ])
  })
})
