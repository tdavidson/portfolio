import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, n: 0 }))
vi.mock('@/lib/accounting/persist', () => ({
  accountIdByCode: async () => new Map([['1000', 'cash'], ['3100', 'pooled']]),
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: any, entry: any, status: string) => {
    const id = `new-${++s.n}`
    s.m.tables.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v', book: 'actual', status, source_type: entry.sourceType, source_ref: entry.sourceRef, vendor_id: entry.vendorId ?? null, entry_date: entry.entryDate })
    for (const p of entry.postings) s.m.tables.journal_postings.push({ journal_entry_id: id, account_id: p.accountId, amount: p.amount, lp_entity_id: p.lpEntityId ?? null })
    return { entryId: id }
  }),
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v' }))
vi.mock('@/lib/accounting/vehicle-domain', () => ({ vehicleKindByName: async () => 'fund' }))
vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: async () => {} }))
vi.mock('@/lib/accounting/vendors', async (orig) => ({ ...(await orig<any>()), vendorResolver: () => async () => null }))
vi.mock('@/lib/accounting/import-review', () => ({ reviewImport: async () => ({ differences: [], token: 't' }) }))

import { importQbJournal } from './import-journal'
import { qbLegacySourceRef, qbSourceRef } from './build-entries'
import type { QbTransaction } from './parse-journal'
import type { JournalSource } from './sources'

const deposit = (name: string, amount = 25_000, date = '2024-03-01', num: string | null = null): QbTransaction => ({
  date, type: 'Deposit', num, memo: null,
  lines: [
    { account: 'Bank', name, memo: null, debit: amount, credit: 0 },
    { account: 'Partner investments', name: null, memo: null, debit: 0, credit: amount },
  ],
})
const ALEX = deposit('Alex Rivera')
const ANN = deposit('Ann Lee')

/** An entry as the first-version importer wrote it. */
function legacy(t: QbTransaction, id: string, over: { lp?: string | null; vendor?: string | null; status?: string; source?: JournalSource } = {}) {
  return {
    entry: { id, fund_id: 'f', vehicle_id: 'v', book: 'actual', status: over.status ?? 'draft', source_type: over.source ?? 'quickbooks', source_ref: qbLegacySourceRef(t, over.source), vendor_id: over.vendor ?? null },
    postings: [
      { journal_entry_id: id, account_id: 'cash', amount: 25_000, lp_entity_id: null },
      { journal_entry_id: id, account_id: over.lp ? `${over.lp}-capital` : 'pooled', amount: -25_000, lp_entity_id: over.lp ?? null },
    ],
  }
}

function seed(old: ReturnType<typeof legacy>[] = [], vendors: { id: string; name: string }[] = []) {
  s.n = 0
  s.m = memoryAdmin({
    qb_account_mappings: ['quickbooks', 'carta'].flatMap(source => [
      { fund_id: 'f', vehicle_id: 'v', source, qb_account: 'Bank', account_code: '1000', excluded: false },
      { fund_id: 'f', vehicle_id: 'v', source, qb_account: 'Partner investments', account_code: '3100', excluded: false },
    ]),
    chart_of_accounts: [
      { id: 'pooled', fund_id: 'f', vehicle_id: 'v', code: '3100', type: 'equity', subtype: 'lp_capital', is_active: true, lp_entity_id: null },
      { id: 'alex-capital', fund_id: 'f', vehicle_id: 'v', code: '3101', type: 'equity', subtype: 'lp_capital', is_active: true, lp_entity_id: 'alex', lp_entities: { entity_name: 'Alex Rivera' } },
      { id: 'ann-capital', fund_id: 'f', vehicle_id: 'v', code: '3102', type: 'equity', subtype: 'lp_capital', is_active: true, lp_entity_id: 'ann', lp_entities: { entity_name: 'Ann Lee' } },
    ],
    journal_entries: old.map(o => o.entry),
    journal_postings: old.flatMap(o => o.postings),
    vendors: vendors.map(v => ({ ...v, fund_id: 'f' })),
    qb_import_runs: [],
  })
}

const run = (transactions: QbTransaction[], opts: { dryRun?: boolean; source?: JournalSource } = {}) => importQbJournal(s.m.admin, {
  fundId: 'f', group: 'Fund I', userId: 'u', transactions, parseErrors: [], dryRun: !!opts.dryRun, includeLp: true, source: opts.source,
}) as Promise<any>
const created = () => s.m.tables.journal_entries.filter((e: any) => e.id.startsWith('new-'))

beforeEach(() => seed())

describe('importQbJournal duplicate check', () => {
  it('imports two same-day, same-amount contributions from different payers, each to its LP', async () => {
    const result = await run([ALEX, ANN])
    expect(result).toMatchObject({ created: 2, alreadyPresent: 0, duplicates: [], recovered: [] })
    expect(created().map((e: any) => e.source_ref)).toEqual([qbSourceRef(ALEX), qbSourceRef(ANN)])
    const lps = s.m.tables.journal_postings.filter((p: any) => p.lp_entity_id).map((p: any) => p.lp_entity_id)
    expect(lps).toEqual(['alex', 'ann'])
    // And a second run adds nothing.
    expect(await run([ALEX, ANN])).toMatchObject({ created: 0, alreadyPresent: 2 })
  })

  it('imports both of two identical transactions in one batch, and neither again on re-run', async () => {
    const result = await run([ALEX, ALEX])
    expect(result).toMatchObject({ created: 2, alreadyPresent: 0 })
    expect(created().map((e: any) => e.source_ref)).toEqual([qbSourceRef(ALEX), `${qbSourceRef(ALEX)}:2`])
    expect(await run([ALEX, ALEX])).toMatchObject({ created: 0, alreadyPresent: 2 })
    // A third copy in a later file is new.
    expect(await run([ALEX, ALEX, ALEX])).toMatchObject({ created: 1, alreadyPresent: 2 })
  })

  it('re-importing a file imported under the old refs imports nothing', async () => {
    const other = deposit('Alex Rivera', 10_000, '2024-04-01', '1001')
    seed([legacy(ALEX, 'old-1', { lp: 'alex' }), legacy(other, 'old-2')])
    const result = await run([ALEX, other])
    expect(result).toMatchObject({ created: 0, alreadyPresent: 2, recovered: [] })
    expect(result.duplicates.map((d: any) => d.existingEntryId)).toEqual(['old-1', 'old-2'])
    expect(result.duplicates[0].reason).toMatch(/before payees were part of the reference; that entry has the same payee or LP/)
    expect(result.duplicates[1].reason).toMatch(/same date, accounts and amounts/)
  })

  it('imports only the contribution an old import dropped, choosing it by LP', async () => {
    // The old importer kept Ann's deposit (the first in its file) and dropped Paul's.
    seed([legacy(ANN, 'old-ann', { lp: 'ann' })])
    const result = await run([ALEX, ANN], { dryRun: true })
    expect(result).toMatchObject({ wouldCreate: 1, alreadyPresent: 1 })
    expect(result.duplicates).toEqual([expect.objectContaining({ existingEntryId: 'old-ann', sourceRef: qbSourceRef(ANN) })])
    expect(result.recovered).toEqual([expect.objectContaining({ sourceRef: qbSourceRef(ALEX), legacyRef: qbLegacySourceRef(ALEX) })])
    expect(result.recovered[0].reason).toMatch(/different payee or LP/)

    await run([ALEX, ANN])
    expect(created().map((e: any) => e.source_ref)).toEqual([qbSourceRef(ALEX)])
    expect(await run([ALEX, ANN])).toMatchObject({ created: 0, alreadyPresent: 2 })
  })

  it('matches by vendor when the old entry carries one', async () => {
    seed([legacy(ANN, 'old-ann', { vendor: 'vendor-ann' })], [{ id: 'vendor-ann', name: 'Ann  Lee' }, { id: 'vendor-alex', name: 'Alex Rivera' }])
    const result = await run([ALEX, ANN], { dryRun: true })
    expect(result.duplicates.map((d: any) => d.sourceRef)).toEqual([qbSourceRef(ANN)])
    expect(result.recovered.map((d: any) => d.sourceRef)).toEqual([qbSourceRef(ALEX)])
  })

  it('pairs by count when the old entry cannot say whose it was, and says so', async () => {
    seed([legacy(ALEX, 'old-1')])
    const result = await run([ALEX, ANN], { dryRun: true })
    expect(result).toMatchObject({ wouldCreate: 1, alreadyPresent: 1 })
    expect(result.duplicates[0].reason).toMatch(/paired by count\. Check that entry is for Alex Rivera/)
    expect(result.recovered[0].reason).toMatch(/2 transactions in this import share an older reference .* with 1 entry in the book; this is one of the 1 not there yet/)
  })

  it('a partly imported file imports only what is missing', async () => {
    const a = deposit('Alex Rivera', 1_000, '2024-05-01', '7')
    const b = deposit('Ann Lee', 2_000, '2024-05-02', '8')
    const c = deposit('Ann Lee', 3_000, '2024-05-03', '9')
    seed([legacy(a, 'old-a'), legacy(b, 'old-b')])
    const result = await run([a, b, c])
    expect(result).toMatchObject({ created: 1, alreadyPresent: 2, recovered: [] })
    expect(created().map((e: any) => e.source_ref)).toEqual([qbSourceRef(c)])
  })

  it('across batches: the other LP\'s deposit in a later batch is not hidden by the old entry', async () => {
    seed([legacy(ANN, 'old-ann', { lp: 'ann' })])
    expect(await run([ANN])).toMatchObject({ created: 0, alreadyPresent: 1 })
    expect(await run([ALEX])).toMatchObject({ created: 1, alreadyPresent: 0 })
  })

  it('a voided entry still blocks re-import, and the reason says so', async () => {
    seed([legacy(ALEX, 'old-1', { lp: 'alex', status: 'void' })])
    const result = await run([ALEX], { dryRun: true })
    expect(result).toMatchObject({ wouldCreate: 0, alreadyPresent: 1 })
    expect(result.duplicates[0]).toMatchObject({ existingStatus: 'void', reason: expect.stringMatching(/voided/) })
  })

  it('runs the same way for Carta, without matching QuickBooks entries', async () => {
    seed([legacy(ANN, 'old-ann', { lp: 'ann', source: 'carta' }), legacy(ALEX, 'qb-alex', { lp: 'alex' })])
    const result = await run([ALEX, ANN], { source: 'carta' })
    expect(result).toMatchObject({ created: 1, alreadyPresent: 1 })
    expect(created().map((e: any) => e.source_ref)).toEqual([qbSourceRef(ALEX, 'carta')])
  })
})
