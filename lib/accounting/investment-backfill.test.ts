import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const h = vi.hoisted(() => ({ derive: vi.fn(), post: vi.fn(), link: vi.fn(), adopt: vi.fn() }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async (_a: any, _f: string, g: string) => { if (g === 'Broken') throw new Error('chart read failed'); return 'v' } }))
vi.mock('./load', () => ({ listVehiclesWithId: async () => [{ name: 'Broken', id: 'b', kind: 'fund' }, { name: 'Fund I', id: 'v', kind: 'fund' }, { name: 'GP', id: 'g', kind: 'associate' }] }))
vi.mock('./from-portfolio', async (orig) => ({ ...(await orig<any>()), draftEntryForTransaction: h.derive }))
vi.mock('./continuous-allocation', () => ({ postExistingEntryWithAllocation: h.post }))
vi.mock('./investment-bank-match', async (orig) => ({ ...(await orig<any>()), linkOpenBankRow: h.link }))
vi.mock('./adoption', async (orig) => ({ ...(await orig<any>()), adoptEntry: h.adopt }))
import { backfillDerivedEntries, backfillAllVehicles, countUnderived } from './investment-backfill'

const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
  { id: 'a1100', fund_id: 'f', vehicle_id: 'v', code: '1100-a', type: 'asset', subtype: 'investment', company_id: 'co' },
  { id: 'b1100', fund_id: 'f', vehicle_id: 'v', code: '1100-b', type: 'asset', subtype: 'investment', company_id: 'co2' },
  { id: 'p4200', fund_id: 'f', vehicle_id: 'v', code: '4200', type: 'income', subtype: 'unrealized', company_id: null },
  { id: 'p1100', fund_id: 'f', vehicle_id: 'v', code: '1100', type: 'asset', subtype: 'investment', company_id: null },
]
const entry = (id: string, over: any = {}) => ({ id, fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-01-15', memo: id, source_ref: null, reversed_by: null, ...over })
const line = (entryId: string, account_id: string, amount: number) => ({ journal_entry_id: entryId, book: 'actual', fund_id: 'f', account_id, amount })
const txn = (id: string, over: any = {}) => ({ id, fund_id: 'f', company_id: 'co', portfolio_group: 'Fund I', transaction_type: 'investment', investment_cost: 100, transaction_date: '2026-02-01', adopted_entry_id: null, ...over })

function seed(t: Record<string, any[]>) {
  return memoryAdmin({
    fund_vehicles: [{ id: 'v', fund_id: 'f', name: 'Fund I', aliases: ['Fund One'] }],
    chart_of_accounts: chart, companies: [{ id: 'co', fund_id: 'f', name: 'Acme' }, { id: 'co2', fund_id: 'f', name: 'Beta' }],
    journal_entries: [], journal_postings: [], investment_transactions: [], ...t,
  })
}

beforeEach(() => {
  h.derive.mockReset().mockResolvedValue({ drafted: true, posted: true, entryId: 'new' })
  h.post.mockReset().mockResolvedValue({ allocationEntryIds: [] })
  h.link.mockReset().mockResolvedValue('b1')
  h.adopt.mockReset().mockResolvedValue({ adoptedIds: ['t-adopted'] })
})

describe('backfillDerivedEntries', () => {
  it('adopts unowned posted investment entries, skipping derived, adopted, income-only and reversal pairs', async () => {
    const m = seed({
      journal_entries: [entry('qb'), entry('derived', { source_ref: 'txn:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), entry('owned'), entry('income'),
        entry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { reversed_by: 'rev' }), entry('rev', { source_ref: 'reversal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })],
      journal_postings: [line('qb', 'a1100', 100), line('derived', 'a1100', 100), line('owned', 'a1100', 100), line('income', 'p4200', -5),
        line('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a1100', 100), line('rev', 'a1100', -100)],
      investment_transactions: [txn('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), txn('o', { adopted_entry_id: 'owned' })],
    })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.adopt).toHaveBeenCalledTimes(1)
    expect(h.adopt.mock.calls[0][2]).toMatchObject({ entryId: 'qb', vehicleId: 'v' })
    expect(r).toMatchObject({ toAdopt: 1, adopted: 1 })
  })
  it('derives transactions with no entry, by name or alias, and leaves adopted ones alone', async () => {
    const m = seed({ investment_transactions: [txn('a'), txn('b', { portfolio_group: 'Fund One' }), txn('c', { adopted_entry_id: 'e' }), txn('r', { transaction_type: 'round_info' })] })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.derive.mock.calls.map(c => c[3].id)).toEqual(['a', 'b'])
    expect(r).toMatchObject({ toDerive: 2, posted: 2 })
  })
  it('posts derived drafts left waiting, then links their bank rows', async () => {
    const m = seed({ investment_transactions: [txn('a')], journal_entries: [entry('d', { status: 'draft', source_ref: 'txn:a' })] })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.post).toHaveBeenCalledWith(m.admin, 'f', 'Fund I', 'u', 'd')
    expect(h.link).toHaveBeenCalledWith(m.admin, 'f', 'd')
    expect(r).toMatchObject({ toPost: 1, posted: 1, linked: 1, toDerive: 0, alreadyDerived: 1 })
  })
  it('adopts a posted txn: entry whose transaction was deleted, and a reversal that is unpaired', async () => {
    const gone = '11111111-1111-4111-8111-111111111111'
    const m = seed({
      journal_entries: [entry('orphan', { source_ref: `txn:${gone}` }), entry('orig2', { source_ref: null }), entry('rev2', { source_ref: 'reversal:22222222-2222-4222-8222-222222222222' })],
      journal_postings: [line('orphan', 'a1100', 100), line('rev2', 'a1100', -50)],
    })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.adopt.mock.calls.map(c => c[2].entryId).sort()).toEqual(['orphan', 'rev2'])
    expect(r.toAdopt).toBe(2)
  })
  it('does not post an orphaned derived draft, and names it', async () => {
    const m = seed({ journal_entries: [entry('d', { status: 'draft', source_ref: 'txn:gone' })] })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.post).not.toHaveBeenCalled()
    expect(r.refused[0]).toMatch(/no longer exists/)
  })
  it('a dry run counts and writes nothing', async () => {
    const m = seed({ investment_transactions: [txn('a', { company_id: 'co2' })], journal_entries: [entry('qb')], journal_postings: [line('qb', 'a1100', 100)] })
    expect(await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u', { dryRun: true })).toMatchObject({ toAdopt: 1, toDerive: 1, adopted: 0, posted: 0, conflicted: [] })
    expect(h.adopt).not.toHaveBeenCalled()
    expect(h.derive).not.toHaveBeenCalled()
  })
  it('running twice books nothing twice', async () => {
    const m = seed({ investment_transactions: [txn('a')] })
    h.derive.mockImplementation(async (_a: any, _f: string, _u: any, t: any) => {
      m.tables.journal_entries.push(entry(`e-${t.id}`, { source_ref: `txn:${t.id}` }))
      return { drafted: true, posted: true, entryId: `e-${t.id}` }
    })
    await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')).toMatchObject({ toDerive: 0, alreadyDerived: 1 })
    expect(h.derive).toHaveBeenCalledTimes(1)
  })
  it('running twice adopts nothing twice', async () => {
    const m = seed({ investment_transactions: [], journal_entries: [entry('qb')], journal_postings: [line('qb', 'a1100', 100)] })
    h.adopt.mockImplementation(async (_a: any, _f: string, args: any) => {
      m.tables.investment_transactions.push(txn('t1', { adopted_entry_id: args.entryId }))
      return { adoptedIds: ['t1'] }
    })
    expect(await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')).toMatchObject({ toAdopt: 1 })
    expect(await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')).toMatchObject({ toAdopt: 0 })
  })
})

describe('backfillDerivedEntries: a position carried by both the tracker and the journal', () => {
  it('a replayed entry plus the tracker row it came from: neither adopted nor derived, and named', async () => {
    const m = seed({ investment_transactions: [txn('a')], journal_entries: [entry('replay')], journal_postings: [line('replay', 'a1100', 100), line('replay', 'cash', -100)] })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.adopt).not.toHaveBeenCalled()
    expect(h.derive).not.toHaveBeenCalled()
    expect(r).toMatchObject({ toAdopt: 0, toDerive: 0, adopted: 0, posted: 0 })
    expect(r.conflicted).toEqual(['Acme: carried by both the tracker and 1 journal entry — reconcile by hand'])
  })
  it('is reported by a dry run too', async () => {
    const m = seed({ investment_transactions: [txn('a')], journal_entries: [entry('replay')], journal_postings: [line('replay', 'a1100', 100)] })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u', { dryRun: true })
    expect(r).toMatchObject({ toAdopt: 0, toDerive: 0 })
    expect(r.conflicted).toHaveLength(1)
  })
  it('a company with only unowned entries is adopted; one with only tracker rows is derived', async () => {
    const m = seed({ investment_transactions: [txn('b', { company_id: 'co2' })], journal_entries: [entry('qb')], journal_postings: [line('qb', 'a1100', 100)] })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.adopt.mock.calls.map(c => c[2].entryId)).toEqual(['qb'])
    expect(h.derive.mock.calls.map(c => c[3].id)).toEqual(['b'])
    expect(r.conflicted).toEqual([])
  })
  it('an entry spanning a conflicted and a clean company is skipped whole', async () => {
    const m = seed({
      investment_transactions: [txn('a')],
      journal_entries: [entry('span')],
      journal_postings: [line('span', 'a1100', 100), line('span', 'b1100', 50), line('span', 'cash', -150)],
    })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.adopt).not.toHaveBeenCalled()
    expect(h.derive).not.toHaveBeenCalled()
    expect(r.conflicted).toEqual(['Acme: carried by both the tracker and 1 journal entry — reconcile by hand'])
    // …and says so for the clean company, which nothing else would ever flag.
    expect(r.refused).toEqual(['Journal entry of 2026-01-15 "span" also carries Beta; not adopted because Acme is carried by both — reconcile Acme by hand, then run this again.'])
  })
  it('the spanning skip is named by a dry run too', async () => {
    const m = seed({
      investment_transactions: [txn('a')],
      journal_entries: [entry('span')],
      journal_postings: [line('span', 'a1100', 100), line('span', 'b1100', 50), line('span', 'cash', -150)],
    })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u', { dryRun: true })
    expect(r.refused).toEqual([expect.stringMatching(/also carries Beta/)])
  })
  it('an entry touching only the conflicted company adds no refusal line', async () => {
    const m = seed({ investment_transactions: [txn('a')], journal_entries: [entry('replay')], journal_postings: [line('replay', 'a1100', 100)] })
    expect((await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')).refused).toEqual([])
  })
})

describe('backfillDerivedEntries: tracker rows behind a pooled account or a waiting draft', () => {
  // Production: an unowned "Investment in Ocrolus at cost" on pooled 1100 (no company) could not be
  // adopted, so the company-keyed check missed it and the tracker purchase was derived — cost twice.
  const pooled = () => seed({
    investment_transactions: [txn('a', { investment_cost: 400001.04 }), txn('b', { company_id: 'co2' })],
    journal_entries: [entry('legacy', { memo: 'Investment in Ocrolus at cost' }), entry('d', { status: 'draft', source_ref: 'txn:b' })],
    journal_postings: [line('legacy', 'p1100', 400001.04), line('legacy', 'cash', -400001.04)],
  })
  const pooledLine = 'Fund I: the pooled investment account 1100 carries 1 journal entry — reconcile by hand before deriving'
  for (const dryRun of [true, false]) {
    it(`an unowned entry on a pooled investment account holds back every company (${dryRun ? 'dry run' : 'live'})`, async () => {
      const m = pooled()
      const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u', { dryRun })
      expect(r.conflicted).toEqual([pooledLine])
      expect(r).toMatchObject({ toAdopt: 0, toDerive: 0, toPost: 0, adopted: 0, posted: 0 })
      expect(h.adopt).not.toHaveBeenCalled()
      expect(h.derive).not.toHaveBeenCalled()
      expect(h.post).not.toHaveBeenCalled()
    })
  }
  it('a pooled entry with no tracker rows waiting conflicts nothing', async () => {
    const m = seed({ journal_entries: [entry('legacy')], journal_postings: [line('legacy', 'p1100', 100), line('legacy', 'cash', -100)] })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(r.conflicted).toEqual([])
    expect(h.adopt.mock.calls.map(c => c[2].entryId)).toEqual(['legacy'])
  })

  // Production: the tracker purchase's derived entry was a draft (so not "pending"), and an unowned
  // legacy entry carried the same purchase — it was adopted AND the draft posted, doubling both sides.
  const drafted = () => seed({
    investment_transactions: [txn('a'), txn('b', { company_id: 'co2' })],
    journal_entries: [entry('d', { status: 'draft', source_ref: 'txn:a' }), entry('legacy')],
    journal_postings: [line('d', 'a1100', 100), line('d', 'cash', -100), line('legacy', 'a1100', 100), line('legacy', 'cash', -100)],
  })
  for (const dryRun of [true, false]) {
    it(`a derived draft plus an unowned entry for the same company: neither adopted nor posted (${dryRun ? 'dry run' : 'live'})`, async () => {
      const m = drafted()
      const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u', { dryRun })
      expect(r.conflicted).toEqual(['Acme: carried by both the tracker and 1 journal entry — reconcile by hand'])
      expect(h.adopt).not.toHaveBeenCalled()
      expect(h.post).not.toHaveBeenCalled()
      expect(r).toMatchObject({ toAdopt: 0, toPost: 0, toDerive: 1, adopted: 0 })
      // The clean company is still derived.
      if (!dryRun) expect(h.derive.mock.calls.map(c => c[3].id)).toEqual(['b'])
      else expect(h.derive).not.toHaveBeenCalled()
    })
  }
})

describe('backfillDerivedEntries on a failed read', () => {
  it('a failed entity read throws instead of dropping the aliases', async () => {
    const m = seed({})
    m.failNext('fund_vehicles', 'select', 'read failed')
    await expect(backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')).rejects.toThrow(/names could not be read: read failed/)
  })
  it('a failed read of the live reversals throws instead of adopting the original as a purchase', async () => {
    const R = '00000000-0000-4000-8000-0000000000r1'.replace('r1', 'b1')
    const m = seed({
      journal_entries: [entry('orig', { reversed_by: R }), entry(R, { source_ref: 'reversal:orig' })],
      journal_postings: [line('orig', 'a1100', 100), line(R, 'a1100', -100)],
    })
    // The reversal-liveness read is the first journal_entries read issued after the entries load.
    let n = 0
    const from = m.admin.from
    m.admin.from = (t: string) => {
      if (t === 'journal_entries' && ++n === 2) m.failNext('journal_entries', 'select', 'reversals unread')
      return from(t)
    }
    await expect(backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')).rejects.toThrow(/reversals unread/)
    expect(h.adopt).not.toHaveBeenCalled()
  })
})

describe('backfillAllVehicles', () => {
  it('a vehicle that throws is reported and the rest continue', async () => {
    const m = seed({})
    const out = await backfillAllVehicles(m.admin, 'f', 'u', null)
    expect(out.map(o => o.vehicle)).toEqual(['Broken', 'Fund I'])
    expect(out[0].result.refused[0]).toBe('Could not be processed: chart read failed')
    expect(out[1].result.refused).toEqual([])
  })
})

describe('countUnderived', () => {
  it('counts what the backfill would derive', async () => {
    const m = seed({ investment_transactions: [txn('a'), txn('b'), txn('c', { adopted_entry_id: 'e' })], journal_entries: [entry('d', { source_ref: 'txn:b' })] })
    expect(await countUnderived(m.admin, 'f', 'v', ['Fund I'])).toBe(1)
  })
})
