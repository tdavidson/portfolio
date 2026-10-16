import { describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'

/**
 * The agent's read tools must never return part of the books as if it were all of them. Every
 * client here enforces PostgREST's max_rows (1000, supabase/config.toml), the cap that made an
 * export missing its newest entries look like unassigned LP capital.
 */

vi.mock('./vehicle-id', async orig => ({ ...(await orig<typeof import('./vehicle-id')>()), vehicleIdByName: async () => 'v1' }))

import { exportLedgerText, exportLedgerTextPage } from './text-ledger-run'
import { getTool } from './agent-tools'
import { loadOwnership } from './load'

const MAX_ROWS = 1000
const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v1', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash', lp_entity_id: null },
  { id: 'cap', fund_id: 'f', vehicle_id: 'v1', code: '3000', name: 'Capital', type: 'equity', subtype: null, lp_entity_id: null },
]
/** `n` one-a-day entries from 2024-01-01, each a 100.00 contribution; entry i is "E<i>". */
function ledger(n: number) {
  const day = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10)
  const journal_entries = Array.from({ length: n }, (_, i) => ({
    id: `e${String(i).padStart(5, '0')}`, fund_id: 'f', vehicle_id: 'v1', book: 'actual', status: 'posted',
    entry_date: day(i), memo: `E${i}`, source_type: 'manual', source_ref: `ref:${i}`,
  }))
  const journal_postings = journal_entries.flatMap(e => [
    { journal_entry_id: e.id, book: 'actual', fund_id: 'f', vehicle_id: 'v1', account_id: 'cash', amount: 100, currency: 'USD' },
    { journal_entry_id: e.id, book: 'actual', fund_id: 'f', vehicle_id: 'v1', account_id: 'cap', amount: -100, currency: 'USD' },
  ])
  return { journal_entries, journal_postings, day }
}
const memos = (text: string) => Array.from(text.matchAll(/^\d{4}-\d{2}-\d{2} [*!] "(E\d+)"/gm), m => m[1])
const ctx = (admin: any) => ({ admin, fundId: 'f', portfolioGroup: 'Fund I', userId: 'u', access: {} as any })

describe('exportLedgerText reads past the 1000-row cap', () => {
  it('exports every entry, newest included', async () => {
    const { journal_entries, journal_postings } = ledger(1500)
    const { admin } = memoryAdmin({ chart_of_accounts: chart, journal_entries, journal_postings }, { maxRows: MAX_ROWS })
    const got = memos(await exportLedgerText(admin, 'f', 'Fund I'))
    expect(got).toHaveLength(1500)
    expect(got[0]).toBe('E0')
    expect(got[1499]).toBe('E1499')
  })

  it('asOf stops at that date, still past the cap', async () => {
    const { journal_entries, journal_postings, day } = ledger(1500)
    const { admin } = memoryAdmin({ chart_of_accounts: chart, journal_entries, journal_postings }, { maxRows: MAX_ROWS })
    const got = memos(await exportLedgerText(admin, 'f', 'Fund I', day(1199)))
    expect(got).toHaveLength(1200)
    expect(got.at(-1)).toBe('E1199')
  })

  it('surfaces a failed read instead of exporting what came back', async () => {
    const { journal_entries, journal_postings } = ledger(5)
    const m = memoryAdmin({ chart_of_accounts: chart, journal_entries, journal_postings }, { maxRows: MAX_ROWS })
    m.failNext('journal_entries', 'select', 'timeout')
    await expect(exportLedgerText(m.admin, 'f', 'Fund I')).rejects.toBeTruthy()
  })
})

describe('exportLedgerTextPage', () => {
  it('returns one untruncated page when the text fits', async () => {
    const { journal_entries, journal_postings } = ledger(1200)
    const { admin } = memoryAdmin({ chart_of_accounts: chart, journal_entries, journal_postings }, { maxRows: MAX_ROWS })
    const page = await exportLedgerTextPage(admin, 'f', 'Fund I', { maxChars: 10_000_000 })
    expect(page).toMatchObject({ entries: 1200, total: 1200, truncated: false })
    expect(page.cursor).toBeUndefined()
    expect(memos(page.text)).toHaveLength(1200)
  })

  it('splits a large export into pages that together hold every entry once', async () => {
    const { journal_entries, journal_postings } = ledger(1500)
    const { admin } = memoryAdmin({ chart_of_accounts: chart, journal_entries, journal_postings }, { maxRows: MAX_ROWS })
    const first = await exportLedgerTextPage(admin, 'f', 'Fund I', { maxChars: 50_000 })
    expect(first.truncated).toBe(true)
    expect(first.total).toBe(1500)
    expect(first.text.length).toBeLessThanOrEqual(50_000)
    expect(first.cursor).toBe(String(first.entries))
    expect(first.note).toMatch(new RegExp(`of 1500\\. Call export_ledger_text again with cursor "${first.cursor}"`))

    const seen = memos(first.text)
    let cursor = first.cursor
    for (let guard = 0; cursor && guard < 100; guard++) {
      const page = await exportLedgerTextPage(admin, 'f', 'Fund I', { maxChars: 50_000, cursor })
      seen.push(...memos(page.text))
      cursor = page.truncated ? page.cursor : undefined
    }
    expect(seen).toEqual(Array.from({ length: 1500 }, (_, i) => `E${i}`))
  })

  it('always returns at least one entry, however small the limit', async () => {
    const { journal_entries, journal_postings } = ledger(3)
    const { admin } = memoryAdmin({ chart_of_accounts: chart, journal_entries, journal_postings })
    const page = await exportLedgerTextPage(admin, 'f', 'Fund I', { maxChars: 1 })
    expect(page).toMatchObject({ entries: 1, total: 3, truncated: true, cursor: '1' })
  })

  it('filters by start and end', async () => {
    const { journal_entries, journal_postings, day } = ledger(1500)
    const { admin } = memoryAdmin({ chart_of_accounts: chart, journal_entries, journal_postings }, { maxRows: MAX_ROWS })
    const page = await exportLedgerTextPage(admin, 'f', 'Fund I', { start: day(100), end: day(1299), maxChars: 10_000_000 })
    expect(page.total).toBe(1200)
    const got = memos(page.text)
    expect([got[0], got.at(-1)]).toEqual(['E100', 'E1299'])
  })
})

describe('export_ledger_text tool', () => {
  it('takes asOf (or end) and start, and reports the page', async () => {
    const { journal_entries, journal_postings, day } = ledger(1500)
    const { admin } = memoryAdmin({ chart_of_accounts: chart, journal_entries, journal_postings }, { maxRows: MAX_ROWS })
    const tool = getTool('export_ledger_text')!
    expect(Object.keys(tool.inputSchema.properties)).toEqual(expect.arrayContaining(['start', 'end', 'asOf', 'cursor']))
    const r = await tool.handler(ctx(admin), { asOf: day(9) })
    expect(r).toMatchObject({ entries: 10, total: 10, truncated: false })
    expect(memos(r.text).at(-1)).toBe('E9')
    const s = await tool.handler(ctx(admin), { start: day(5), end: day(9) })
    expect(s.total).toBe(5)
  })

  it('refuses a malformed date rather than ignoring it', async () => {
    const { admin } = memoryAdmin({ chart_of_accounts: chart })
    await expect(getTool('export_ledger_text')!.handler(ctx(admin), { asOf: 'last March' })).rejects.toThrow(/ISO date/)
  })
})

describe('list_journal pages', () => {
  it('walks every entry, newest first, with hasMore / nextCursor / total', async () => {
    const { journal_entries, journal_postings } = ledger(1200)
    const { admin } = memoryAdmin({ chart_of_accounts: chart, journal_entries, journal_postings }, { maxRows: MAX_ROWS })
    const tool = getTool('list_journal')!
    const first = await tool.handler(ctx(admin), { limit: 500 })
    expect(first).toMatchObject({ total: 1200, hasMore: true, nextCursor: '500' })
    expect(first.rows).toHaveLength(500)
    expect(first.rows[0].memo).toBe('E1199')
    expect(first.rows[0].journal_postings).toHaveLength(2)
    expect(first.note).toMatch(/cursor "500"/)

    const ids: string[] = first.rows.map((r: any) => r.id)
    let cursor = first.nextCursor
    while (cursor) {
      const page = await tool.handler(ctx(admin), { limit: 500, cursor })
      ids.push(...page.rows.map((r: any) => r.id))
      cursor = page.nextCursor
      if (!page.hasMore) expect(page.note).toBeUndefined()
    }
    expect(new Set(ids).size).toBe(1200)
  })

  it('clamps limit to 500 and filters by date', async () => {
    const { journal_entries, journal_postings, day } = ledger(1200)
    const { admin } = memoryAdmin({ chart_of_accounts: chart, journal_entries, journal_postings }, { maxRows: MAX_ROWS })
    const tool = getTool('list_journal')!
    expect((await tool.handler(ctx(admin), { limit: 5000 })).rows).toHaveLength(500)
    const r = await tool.handler(ctx(admin), { start: day(10), end: day(19) })
    expect(r).toMatchObject({ total: 10, hasMore: false, nextCursor: null })
  })
})

describe('list_bank_transactions pages', () => {
  const txns = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `b${String(i).padStart(5, '0')}`, fund_id: 'f', vehicle_id: 'v1',
    txn_date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    amount: 10, description: `T${i}`, counterparty: null, status: i % 2 ? 'reconciled' : 'unmatched',
    suggested_account_code: null, journal_entry_id: null,
  }))

  it('walks past 1000 rows, and filters by status', async () => {
    const { admin } = memoryAdmin({ bank_transactions: txns(1500) }, { maxRows: MAX_ROWS })
    const tool = getTool('list_bank_transactions')!
    const first = await tool.handler(ctx(admin), {})
    expect(first).toMatchObject({ total: 1500, hasMore: true, nextCursor: '500' })
    expect(first.rows[0].description).toBe('T1499')
    const ids: string[] = first.rows.map((r: any) => r.id)
    let cursor = first.nextCursor
    while (cursor) {
      const page = await tool.handler(ctx(admin), { cursor, limit: 1000 })
      ids.push(...page.rows.map((r: any) => r.id))
      cursor = page.nextCursor
    }
    expect(new Set(ids).size).toBe(1500)
    expect((await tool.handler(ctx(admin), { status: 'unmatched', limit: 1000 })).total).toBe(750)
  })

  it('bank_reconciliation counts every transaction', async () => {
    const { admin } = memoryAdmin({ chart_of_accounts: chart, bank_transactions: txns(1500) }, { maxRows: MAX_ROWS })
    const r = await getTool('bank_reconciliation')!.handler(ctx(admin), {})
    expect(r).toMatchObject({ matchedCount: 750, unmatchedCount: 750, bankEndingBalance: 15000 })
  })
})

describe('LP reads past the cap', () => {
  it('loadOwnership keeps every partner when lp_investments passes 1000 rows', async () => {
    const lp_investments = Array.from({ length: 1200 }, (_, i) => ({
      id: `i${String(i).padStart(5, '0')}`, fund_id: 'f', portfolio_group: 'Fund I', entity_id: `lp${i}`,
      commitment: 1000, paid_in_capital: 0, distributions: 0, snapshot_id: null, updated_at: '2026-01-01',
    }))
    const { admin } = memoryAdmin({ lp_investments }, { maxRows: MAX_ROWS })
    expect(await loadOwnership(admin, 'f', 'Fund I')).toHaveLength(1200)
  })
})
