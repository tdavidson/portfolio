import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import { advanceBalances, applyAdvancesToCall, buildAdvanceEntry, postCallCharges, postDistributionDeductions } from './call-extras'
import { persistEntry } from './persist'
import { applySettlements, settlementsFromPostings } from './settlement'

const books = () => memoryAdmin({
  fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'Fund I', active: true, kind: 'fund' }],
  chart_of_accounts: [
    { id: 'cash', fund_id: 'f1', vehicle_id: 'v1', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
    { id: 'due', fund_id: 'f1', vehicle_id: 'v1', code: '1300', name: 'Due from LPs', type: 'asset', subtype: 'receivable' },
    { id: 'payable', fund_id: 'f1', vehicle_id: 'v1', code: '2300', name: 'Distributions payable', type: 'liability', subtype: 'distributions_payable' },
    { id: 'adv', fund_id: 'f1', vehicle_id: 'v1', code: '2350', name: 'Capital contributions received in advance', type: 'liability', subtype: 'capital_advance' },
    { id: 'interest', fund_id: 'f1', vehicle_id: 'v1', code: '4100', name: 'Interest income', type: 'income', subtype: 'interest_income' },
    { id: 'withheld', fund_id: 'f1', vehicle_id: 'v1', code: '2000', name: 'Accrued expenses', type: 'liability', subtype: 'accrued' },
  ],
  lp_entities: [{ id: 'a', fund_id: 'f1', entity_name: 'Alder LP' }, { id: 'b', fund_id: 'f1', entity_name: 'Birch LP' }],
  journal_entries: [], journal_postings: [], accounting_periods: [],
}, {
  // The database defaults a posting's book to 'actual'; the ledger loader reads by it.
  before: (table, op, payload) => {
    if (table === 'journal_postings' && op === 'insert') for (const row of [payload].flat()) row.book ??= 'actual'
  },
})

const postingsOn = (tables: any, account: string) => tables.journal_postings.filter((p: any) => p.account_id === account)
  .map((p: any) => ({ accountId: p.account_id, amount: Number(p.amount), lpEntityId: p.lp_entity_id, entryId: p.journal_entry_id, entryDate: tables.journal_entries.find((e: any) => e.id === p.journal_entry_id)?.entry_date }))

describe('money received before a call', () => {
  it('waits in received-in-advance, and the next call applies it — once — so only the rest is due', async () => {
    const { admin, tables } = books()
    await persistEntry(admin as any, 'f1', 'Fund I', 'u', buildAdvanceEntry({ fundId: 'f1', entryDate: '2026-09-20' }, 'a', 30000, 'cash', 'adv'), 'posted')
    expect(await advanceBalances(admin as any, 'f1', 'Fund I')).toEqual(new Map([['a', 30000]]))

    const lines = new Map([['a', 100000], ['b', 50000]])
    expect(await applyAdvancesToCall(admin as any, 'f1', 'Fund I', 'u', { callId: 'k1', callDate: '2026-10-01', lines })).toEqual({ applied: new Map([['a', 30000]]) })
    expect(await advanceBalances(admin as any, 'f1', 'Fund I')).toEqual(new Map())
    // Retrying the issue applies nothing more.
    expect(await applyAdvancesToCall(admin as any, 'f1', 'Fund I', 'u', { callId: 'k1', callDate: '2026-10-01', lines })).toEqual({ applied: new Map() })

    // The register sees the advance as a payment on Alder's line.
    const settled = applySettlements(
      [{ id: 'la', lpEntityId: 'a', date: '2026-10-01', amount: 100000 }, { id: 'lb', lpEntityId: 'b', date: '2026-10-01', amount: 50000 }],
      settlementsFromPostings(postingsOn(tables, 'due'), 'due', 'receivable'),
    )
    expect(settled.get('la')).toMatchObject({ settled: 30000, outstanding: 70000, status: 'partial' })
    expect(settled.get('lb')).toMatchObject({ settled: 0, status: 'open' })
  })

  it('never applies more than the partner is called for', async () => {
    const { admin } = books()
    await persistEntry(admin as any, 'f1', 'Fund I', 'u', buildAdvanceEntry({ fundId: 'f1', entryDate: '2026-09-20' }, 'a', 250000, 'cash', 'adv'), 'posted')
    await applyAdvancesToCall(admin as any, 'f1', 'Fund I', 'u', { callId: 'k1', callDate: '2026-10-01', lines: new Map([['a', 100000]]) })
    expect(await advanceBalances(admin as any, 'f1', 'Fund I')).toEqual(new Map([['a', 150000]]))
  })
})

describe('charges on a call, deductions from a distribution', () => {
  it('a charge adds to what the partner owes and credits the account it belongs to', async () => {
    const { admin, tables } = books()
    const r = await postCallCharges(admin as any, 'f1', 'Fund I', 'u', { callId: 'k1', callDate: '2026-10-01', charges: [{ lpEntityId: 'b', amount: 1250, accountId: 'withheld', description: 'Late interest on call #7' }] })
    expect(r).toEqual({ posted: 1 })
    expect(postingsOn(tables, 'due').map((p: any) => [p.lpEntityId, p.amount])).toEqual([['b', 1250]])
    expect(postingsOn(tables, 'withheld').map((p: any) => p.amount)).toEqual([-1250])
    expect(tables.journal_entries[0]).toMatchObject({ memo: 'Late interest on call #7', source_ref: 'call-charge:k1:0' })
    expect(await postCallCharges(admin as any, 'f1', 'Fund I', 'u', { callId: 'k1', callDate: '2026-10-01', charges: [{ lpEntityId: 'b', amount: 1250, accountId: 'withheld', description: 'x' }] })).toEqual({ posted: 0 })
  })

  it('a deduction counts as paid on the distribution, and can net an unpaid call', async () => {
    const { admin, tables } = books()
    const r = await postDistributionDeductions(admin as any, 'f1', 'Fund I', 'u', {
      distributionId: 'd1', date: '2026-10-15', lines: new Map([['a', 40000]]),
      deductions: [
        { lpEntityId: 'a', amount: 2000, accountId: 'withheld', description: 'Tax withheld' },
        { lpEntityId: 'a', amount: 5000, accountId: 'due', description: 'Unpaid on call #8' },
      ],
    })
    expect(r).toEqual({ posted: 2 })
    // The receivable it nets is Alder's own.
    expect(postingsOn(tables, 'due').map((p: any) => [p.lpEntityId, p.amount])).toEqual([['a', -5000]])
    const settled = applySettlements([{ id: 'l', lpEntityId: 'a', date: '2026-10-15', amount: 40000 }], settlementsFromPostings(postingsOn(tables, 'payable'), 'payable', 'payable'))
    expect(settled.get('l')).toMatchObject({ settled: 7000, outstanding: 33000 })
  })

  it('refuses a deduction larger than what the partner is owed', async () => {
    const { admin } = books()
    const r = await postDistributionDeductions(admin as any, 'f1', 'Fund I', 'u', { distributionId: 'd1', date: '2026-10-15', lines: new Map([['a', 100]]), deductions: [{ lpEntityId: 'b', amount: 50, accountId: 'withheld', description: 'x' }] })
    expect(r).toEqual({ error: expect.stringMatching(/larger than what that partner is owed/) })
  })
})
