import { describe, expect, it } from 'vitest'
import { parseMoney, parseRegisterSheet, parseSheetDate, recordRegisterPayments } from './register-import'
import { memoryAdmin } from '../../tests/helpers/memory-admin'

const partners = [
  { lpEntityId: 'a', name: 'Hemrock Founders Capital LP' },
  { lpEntityId: 'b', name: 'Northstar Family Office I LLC' },
  { lpEntityId: 'c', name: 'Coastal University Endowment' },
]

describe('parseRegisterSheet', () => {
  it('reads a pasted call: amounts, what was paid and when, matched to partners by name', () => {
    const sheet = [
      'Partner\tCalled\tFunded\tPaid on',
      'Hemrock Founders Capital, L.P.\t$400,000.00\t400,000\t10/5/2026',
      'Northstar Family Office\t300000\t\t',
      'Coastal University Endowment\t250,000\t125,000\t2026-10-07',
      'Someone Else\t50,000\t\t',
      'Total\t1,000,000\t525,000\t',
    ].join('\n')
    const r = parseRegisterSheet(sheet, partners)
    expect(r.error).toBeNull()
    expect(r.lines).toEqual([
      { lpEntityId: 'a', name: 'Hemrock Founders Capital LP', amount: 400000, paid: 400000, paidOn: '2026-10-05', prepaid: 0, outstandingApplied: 0 },
      { lpEntityId: 'b', name: 'Northstar Family Office I LLC', amount: 300000, paid: 0, paidOn: null, prepaid: 0, outstandingApplied: 0 },
      { lpEntityId: 'c', name: 'Coastal University Endowment', amount: 250000, paid: 125000, paidOn: '2026-10-07', prepaid: 0, outstandingApplied: 0 },
    ])
    expect(r.unmatched).toEqual(['Someone Else'])
  })

  it("reads Carta's capital-activity export: sections, prepaid applied, earlier balances, the Total row", () => {
    const sheet = [
      'Investor\tCommitment\tContribution\tPrepaid Contributions Applied\tCapital Received\tOutstanding Balances Applied\tTotal Due to Fund\tPost Call\tPost Call %',
      'Participating Investors\t\t\t\t\t\t\t\t',
      'Hemrock Founders Capital LP\t50000\t7500\t0\t7500\t0\t7500\t46500\t0.93',
      'Northstar Family Office I LLC\t5000\t750\t750\t0\t0\t0\t4650\t0.93',
      'Coastal University Endowment\t250000\t37500\t0\t0\t12000\t49500\t232500\t0.93',
      'Non-Participating Investors\t\t\t\t\t\t\t\t',
      'Someone Else\t\t\t\t\t\t\t\t',
      'Total\t305000\t45750\t750\t\t12000\t57000\t283650\t',
    ].join('\n')
    const r = parseRegisterSheet(sheet, partners)
    expect(r.error).toBeNull()
    expect(r.lines.map(l => [l.name, l.amount, l.paid, l.prepaid, l.outstandingApplied])).toEqual([
      ['Hemrock Founders Capital LP', 7500, 7500, 0, 0],
      ['Northstar Family Office I LLC', 750, 0, 750, 0],
      ['Coastal University Endowment', 37500, 0, 0, 12000],
    ])
    expect(r.unmatched).toEqual([])
  })

  it('reads comma-separated with quoted names, and caps a payment at the amount', () => {
    const r = parseRegisterSheet('Investor,Distribution,Paid\n"Coastal University Endowment",100,150', partners)
    expect(r.lines[0]).toMatchObject({ lpEntityId: 'c', amount: 100, paid: 100 })
  })

  it('says what is wrong with a sheet it cannot read', () => {
    expect(parseRegisterSheet('just one line', partners).error).toMatch(/header row/)
    expect(parseRegisterSheet('Partner\tNotes\nNorthstar\thello', partners).error).toMatch(/No amount column/)
  })

  it('reads money and dates the way spreadsheets write them', () => {
    expect(parseMoney('$1,234.56')).toBe(1234.56)
    expect(parseMoney('(500)')).toBe(-500)
    expect(parseMoney('n/a')).toBeNull()
    expect(parseSheetDate('2/31/2026')).toBeNull()
    expect(parseSheetDate('10/05/26')).toBe('2026-10-05')
  })
})

describe('recordRegisterPayments', () => {
  const ledger = () => memoryAdmin({
    fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'Fund I', active: true, kind: 'fund' }],
    chart_of_accounts: [
      { id: 'cash', fund_id: 'f1', vehicle_id: 'v1', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
      { id: 'due', fund_id: 'f1', vehicle_id: 'v1', code: '1300', name: 'Due from LPs', type: 'asset', subtype: 'receivable' },
    ],
    lp_entities: [{ id: 'a', fund_id: 'f1', entity_name: 'Hemrock Founders Capital LP' }, { id: 'c', fund_id: 'f1', entity_name: 'Coastal University Endowment' }],
    journal_entries: [], journal_postings: [], accounting_periods: [],
  })

  it('posts cash against Due from LPs per partner, capped at the line and never before the call — and only once', async () => {
    const { admin, tables } = ledger()
    const input = { kind: 'call' as const, registerId: 'k1', registerDate: '2026-10-01', lines: new Map([['a', 400000], ['c', 250000]]), payments: [
      { lpEntityId: 'a', amount: 400000, date: '2026-10-05' },
      { lpEntityId: 'c', amount: 999999, date: '2026-09-01' },
    ] }
    expect(await recordRegisterPayments(admin as any, 'f1', 'Fund I', 'u1', input)).toEqual({ posted: 2 })
    const entries = tables.journal_entries
    expect(entries.map((e: any) => [e.entry_date, e.source_ref])).toEqual([
      ['2026-10-05', 'register-import:k1:a'],
      ['2026-10-01', 'register-import:k1:c'],
    ])
    const c = tables.journal_postings.filter((p: any) => p.journal_entry_id === entries[1].id)
    expect(c.map((p: any) => [p.account_id, Number(p.amount), p.lp_entity_id ?? null])).toEqual([['cash', 250000, null], ['due', -250000, 'c']])
    // The same import again: nothing new.
    expect(await recordRegisterPayments(admin as any, 'f1', 'Fund I', 'u1', input)).toEqual({ posted: 0 })
  })

  it('refuses a payment for a partner who is not on the register', async () => {
    const { admin } = ledger()
    const r = await recordRegisterPayments(admin as any, 'f1', 'Fund I', 'u1', { kind: 'call', registerId: 'k1', registerDate: '2026-10-01', lines: new Map([['a', 1]]), payments: [{ lpEntityId: 'z', amount: 1 }] })
    expect(r).toEqual({ error: expect.stringMatching(/not on this register/) })
  })
})
