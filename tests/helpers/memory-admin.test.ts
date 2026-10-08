import { describe, it, expect } from 'vitest'
import { memoryAdmin } from './memory-admin'

describe('memoryAdmin', () => {
  it('filters, embeds postings under entries, and pages', async () => {
    const { admin } = memoryAdmin({
      journal_entries: [{ id: 'e1', fund_id: 'f', book: 'actual', status: 'posted', source_ref: 'txn:1' }, { id: 'e2', fund_id: 'f', book: 'actual', status: 'draft', source_ref: null }],
      journal_postings: [{ id: 'p1', journal_entry_id: 'e1', account_id: 'a', amount: 5 }],
    })
    const { data } = await admin.from('journal_entries').select('id, journal_postings(account_id, amount)')
      .eq('fund_id', 'f').like('source_ref', 'txn:%').neq('status', 'void')
    expect(data).toEqual([{ id: 'e1', fund_id: 'f', book: 'actual', status: 'posted', source_ref: 'txn:1', journal_postings: [{ id: 'p1', journal_entry_id: 'e1', account_id: 'a', amount: 5 }] }])
    const { data: none } = await admin.from('journal_entries').select('id').is('source_ref', null).range(1, 5)
    expect(none).toEqual([])
  })

  it('inserts with ids, updates by compare-and-set, deletes, and enforces unique keys', async () => {
    const m = memoryAdmin({}, { unique: [{ table: 'bank_transactions', key: r => r.journal_entry_id ?? null }] })
    const { data: ins } = await m.admin.from('bank_transactions').insert([{ journal_entry_id: 'e1', status: 'reconciled' }]).select('id')
    expect(ins).toHaveLength(1)
    const dup = await m.admin.from('bank_transactions').insert({ journal_entry_id: 'e1' })
    expect(dup.error?.message).toMatch(/unique/)
    const { data: none } = await m.admin.from('bank_transactions').update({ status: 'x' }).eq('status', 'drafted').select('id')
    expect(none).toEqual([])
    m.failNext('bank_transactions', 'delete', 'boom')
    expect((await m.admin.from('bank_transactions').delete().eq('id', ins![0].id)).error?.message).toBe('boom')
    await m.admin.from('bank_transactions').delete().eq('id', ins![0].id)
    expect(m.tables.bank_transactions).toEqual([])
  })

  it('maybeSingle returns one row or null; count with head', async () => {
    const { admin } = memoryAdmin({ t: [{ id: '1', k: 'a' }, { id: '2', k: 'a' }] })
    expect((await admin.from('t').select('*').eq('id', '2').maybeSingle()).data).toEqual({ id: '2', k: 'a' })
    expect((await admin.from('t').select('*').eq('id', '9').maybeSingle()).data).toBeNull()
    expect((await admin.from('t').select('id', { count: 'exact', head: true }).eq('k', 'a')).count).toBe(2)
  })

  it('calls before hook before computing matched, allowing concurrent writes to affect filtering (Ruling R1)', async () => {
    const m = memoryAdmin({ t: [{ id: '1', status: 'draft' }] }, {
      before: (table, mode, payload, tables) => {
        if (mode === 'update') {
          // Simulate a concurrent request that posted this row
          tables.t[0].status = 'posted'
        }
      }
    })
    const { data } = await m.admin.from('t').update({ x: 1 }).eq('status', 'draft').select('id')
    // After before hook runs and changes status to 'posted', the filter eq('status', 'draft') should match nothing
    expect(data).toEqual([])
  })
})
