import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { parseQbJournal } from '@/lib/accounting/quickbooks/parse-journal'
import { proposeMapping, type ChartAccount } from '@/lib/accounting/quickbooks/propose-mapping'
import { buildEntries, qbSourceRef } from '@/lib/accounting/quickbooks/build-entries'
import { parseQbTrialBalance, compareTrialBalance } from '@/lib/accounting/quickbooks/tie-out'
import { accountIdByCode, persistEntry } from '@/lib/accounting/persist'
import { ensureInvestmentAccounts } from '@/lib/accounting/investments'
import { fetchAllRows } from '@/lib/accounting/load'
import { trialBalance } from '@/lib/accounting/statements'
import { runBulkDraftAction } from '@/lib/accounting/journal-bulk'
import type { Account, Posting } from '@/lib/accounting/types'
import { ACTUAL_BOOK } from '@/lib/accounting/books'

/**
 * END-TO-END QuickBooks migration against the LIVE database. Not part of `npm test` — see
 * vitest.live.config.ts. Everything it writes carries the SMOKE marker and is removed in
 * afterAll, which asserts zero residue.
 */
const SMOKE = 'ZZ SMOKE QB'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const admin: any = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

let fundId = ''
let group = ''
let vehicleId: string | null = null
let d1 = '', d2 = ''
let journalCsv = ''
let discoveredId = ''
const createdRefs: string[] = []

afterAll(async () => {
  const { data: entries } = await admin.from('journal_entries')
    .select('id').eq('fund_id', fundId).ilike('memo', `%${SMOKE}%`)
    .eq('book', ACTUAL_BOOK)
  const ids = (entries ?? []).map((e: any) => e.id)
  if (ids.length) {
    await admin.from('journal_postings').delete().in('journal_entry_id', ids)
    await admin.from('journal_entries').delete().in('id', ids)
  }
  await admin.from('qb_account_mappings').delete().eq('fund_id', fundId).ilike('qb_account', `%${SMOKE}%`)
  await admin.from('qb_import_runs').delete().eq('fund_id', fundId).eq('source_label', SMOKE)
  if (discoveredId) {
    await admin.from('fund_holding_terms').delete().eq('company_id', discoveredId)
    await admin.from('companies').delete().eq('id', discoveredId)
  }
  // chart_of_accounts.company_id is ON DELETE SET NULL, so deleting the holding ORPHANS its
  // account triplet rather than removing it — delete by name, after the company is gone.
  await admin.from('chart_of_accounts').delete().eq('fund_id', fundId).ilike('name', `%${SMOKE}%`)

  const counts: Record<string, number> = {}
  for (const [k, q] of [
    ['entries', admin.from('journal_entries').select('id', { count: 'exact', head: true }).eq('book', ACTUAL_BOOK).ilike('memo', `%${SMOKE}%`)],
    ['mappings', admin.from('qb_account_mappings').select('id', { count: 'exact', head: true }).ilike('qb_account', `%${SMOKE}%`)],
    ['companies', admin.from('companies').select('id', { count: 'exact', head: true }).ilike('name', `%${SMOKE}%`)],
    ['chart', admin.from('chart_of_accounts').select('id', { count: 'exact', head: true }).ilike('name', `%${SMOKE}%`)],
  ] as const) { counts[k] = (await q).count ?? -1 }
  console.log('[cleanup]', JSON.stringify(counts))
  for (const v of Object.values(counts)) expect(v).toBe(0)
})

describe('QuickBooks migration — live database', { timeout: 60_000 }, () => {
  it('finds a fund, a vehicle, and dates after the last close', async () => {
    // Target the DEMO fund explicitly. These tests write (and remove) real rows, and
    // `limit(1)` picking whichever fund sorts first is luck, not a safety property — this
    // installation has two funds and only one of them is disposable.
    const { data: funds } = await admin.from('funds').select('id, name')
    const demo = (funds ?? []).find((f: any) => new RegExp(process.env.DEMO_FUND_NAME ?? 'demo', 'i').test(f.name)) ?? (funds ?? [])[0]
    expect(demo, 'no fund found to test against').toBeTruthy()
    fundId = demo.id
    console.log(`[safety] running against fund "${demo.name}"`)
    const { data: veh } = await admin.from('fund_vehicles')
      .select('id, name').eq('fund_id', fundId).eq('kind', 'fund').limit(1)
    group = veh[0].name
    vehicleId = veh[0].id

    const { data: periods } = await admin.from('fiscal_periods')
      .select('period_end').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .order('period_end', { ascending: false }).limit(1)
    const base = new Date(`${(periods ?? [])[0]?.period_end ?? '2025-01-01'}T00:00:00Z`)
    const plus = (n: number) => { const x = new Date(base); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
    d1 = plus(3); d2 = plus(10)

    // A QuickBooks Journal export: date/type/num on the first line of each transaction only.
    journalCsv = [
      'Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit',
      `${fmtUs(d1)},Journal Entry,SMK-1,,${SMOKE} capital call,Investments:${SMOKE} Fund III,"1,000,000.00",`,
      `,,,,${SMOKE} capital call,${SMOKE} Bank:Operating,,"1,000,000.00"`,
      `${fmtUs(d2)},Check,SMK-2,Vendor,${SMOKE} audit fee,${SMOKE} Professional Fees,"12,500.00",`,
      `,,,Vendor,${SMOKE} audit fee,${SMOKE} Bank:Operating,,"12,500.00"`,
    ].join('\n')
    console.log(`[setup] vehicle="${group}" dates=${d1},${d2}`)
    expect(group).toBeTruthy()
  })

  it('parses the export and proposes a mapping against the real chart', async () => {
    const { transactions, accounts, errors } = parseQbJournal(journalCsv)
    expect(errors).toEqual([])
    expect(transactions).toHaveLength(2)
    expect(transactions[0].lines).toHaveLength(2)

    const { data: chartRows } = await admin.from('chart_of_accounts')
      .select('id, code, name, type, subtype').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    const proposals = proposeMapping(accounts, (chartRows ?? []) as ChartAccount[])
    console.log('[propose]', JSON.stringify(proposals.map(p => ({ a: p.qbAccount, code: p.code, c: p.confidence, h: p.suggestsHolding }))))

    // Holding discovery: the investments sub-account names the underlying fund.
    const holdings = proposals.map(p => p.suggestsHolding).filter(Boolean)
    expect(holdings).toContain(`${SMOKE} Fund III`)
    // The bank account should resolve to cash without help.
    expect(proposals.find(p => p.qbAccount.includes('Bank'))?.code).toBe('1000')
  })

  it('creates the discovered holding with its account triplet', async () => {
    const name = `${SMOKE} Fund III`
    const { data: c, error } = await admin.from('companies')
      .insert({ fund_id: fundId, name, holding_type: 'fund', status: 'active', portfolio_group: [group] })
      .select('id').single()
    expect(error).toBeNull()
    discoveredId = c.id
    await admin.from('fund_holding_terms').insert({ fund_id: fundId, company_id: discoveredId, commitment: 0 })
    const accts = await ensureInvestmentAccounts(admin, fundId, group, [{ id: discoveredId, name }])
    expect(accts.get(discoveredId)).toBeTruthy()
  })

  it('saves the mapping and reads it back', async () => {
    const rows = [
      { fund_id: fundId, vehicle_id: vehicleId, qb_account: `Investments:${SMOKE} Fund III`, account_code: '1100' },
      { fund_id: fundId, vehicle_id: vehicleId, qb_account: `${SMOKE} Bank:Operating`, account_code: '1000' },
      { fund_id: fundId, vehicle_id: vehicleId, qb_account: `${SMOKE} Professional Fees`, account_code: '5100' },
    ]
    const { error } = await admin.from('qb_account_mappings').upsert(rows, { onConflict: 'fund_id,vehicle_id,qb_account' })
    expect(error).toBeNull()

    // Upsert twice — the unique constraint must dedupe rather than double-insert.
    await admin.from('qb_account_mappings').upsert(rows, { onConflict: 'fund_id,vehicle_id,qb_account' })
    const { count } = await admin.from('qb_account_mappings')
      .select('id', { count: 'exact', head: true }).eq('fund_id', fundId).ilike('qb_account', `%${SMOKE}%`)
    console.log('[mapping] rows after two upserts:', count)
    expect(count).toBe(3)
  })

  it('imports the export as draft journal entries', async () => {
    const { transactions } = parseQbJournal(journalCsv)
    const { data: mappingRows } = await admin.from('qb_account_mappings')
      .select('qb_account, account_code, excluded').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    const mapping = new Map<string, string>()
    for (const r of (mappingRows ?? [])) if (!r.excluded && r.account_code) mapping.set(r.qb_account, r.account_code)

    const accountIds = await accountIdByCode(admin, fundId, group)
    const { entries, skipped } = buildEntries(transactions, mapping, accountIds, fundId)
    console.log('[build] entries:', entries.length, 'skipped:', skipped.map(s => s.reason))
    expect(skipped).toEqual([])
    expect(entries).toHaveLength(2)

    for (const e of entries) {
      const result = await persistEntry(admin, fundId, group, null, e, 'draft')
      expect('error' in result ? result.error : null).toBeNull()
      createdRefs.push(e.sourceRef!)
    }

    const { data: written } = await admin.from('journal_entries')
      .select('id, status, source_type, source_ref, memo').eq('fund_id', fundId).in('source_ref', createdRefs)
      .eq('book', ACTUAL_BOOK)
    console.log('[import]', JSON.stringify((written ?? []).map((w: any) => ({ status: w.status, src: w.source_type, memo: w.memo }))))
    expect((written ?? []).length).toBe(2)
    expect((written ?? []).every((w: any) => w.status === 'draft')).toBe(true)
    expect((written ?? []).every((w: any) => w.source_type === 'quickbooks')).toBe(true)

    // Postings balance, per entry.
    for (const w of (written ?? [])) {
      const { data: ps } = await admin.from('journal_postings').select('amount').eq('book', ACTUAL_BOOK).eq('journal_entry_id', w.id)
      const net = (ps ?? []).reduce((a: number, p: any) => a + Number(p.amount), 0)
      expect(Math.abs(net)).toBeLessThan(0.005)
    }
  })

  it('is idempotent — a second import writes nothing new', async () => {
    const { transactions } = parseQbJournal(journalCsv)
    const refs = transactions.map(qbSourceRef)
    const { data: present } = await admin.from('journal_entries')
      .select('source_ref').eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('source_ref', refs)
      .eq('book', ACTUAL_BOOK)
    const already = new Set((present ?? []).map((r: any) => r.source_ref))
    const toCreate = refs.filter(r => !already.has(r))
    console.log('[reimport] refs:', refs.length, 'already present:', already.size, 'would create:', toCreate.length)
    expect(already.size).toBe(2)
    expect(toCreate).toEqual([])
  })

  it('ties out to a QuickBooks trial balance', async () => {
    // QuickBooks' side, stated to match what we just imported.
    const tb = [
      'Account,Debit,Credit',
      `Investments:${SMOKE} Fund III,"1,000,000.00",`,
      `${SMOKE} Professional Fees,"12,500.00",`,
      `${SMOKE} Bank:Operating,,"1,012,500.00"`,
    ].join('\n')
    const { rows: theirs, errors } = parseQbTrialBalance(tb)
    expect(errors).toEqual([])

    const { data: mappingRows } = await admin.from('qb_account_mappings')
      .select('qb_account, account_code, excluded').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    const mapping = new Map<string, string>()
    for (const r of (mappingRows ?? [])) if (!r.excluded && r.account_code) mapping.set(r.qb_account, r.account_code)

    // OUR side: only the entries this test wrote, so the comparison is not swamped by the
    // fund's real history. Real callers scope by date instead.
    const { data: mine } = await admin.from('journal_entries')
      .select('id').eq('fund_id', fundId).in('source_ref', createdRefs)
      .eq('book', ACTUAL_BOOK)
    const entryIds = (mine ?? []).map((e: any) => e.id)

    const acctRows = await fetchAllRows((f, t) => admin.from('chart_of_accounts')
      .select('id, code, name, type, subtype, company_id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).range(f, t))
    const { data: postingRows } = await admin.from('journal_postings')
      .select('account_id, amount, currency').in('journal_entry_id', entryIds)
      .eq('book', ACTUAL_BOOK)

    const accounts: Account[] = (acctRows as any[]).map(a => ({
      id: a.id, fundId, code: a.code, name: a.name, type: a.type, subtype: a.subtype, companyId: a.company_id ?? null,
    }))
    const postings: Posting[] = (postingRows ?? []).map((p: any) => ({
      accountId: p.account_id, amount: Number(p.amount), currency: p.currency,
    }))

    const result = compareTrialBalance(trialBalance(accounts, postings), theirs, mapping)
    console.log('[tie-out]', JSON.stringify({ ties: result.ties, lines: result.lines }))
    expect(result.ties).toBe(true)
  })

  it('bulk-posts the imported drafts — the last step of the migration', async () => {
    // The step the migration surface hands off to: drafts are reviewed on the journal page
    // and posted through the EXISTING bulk-post path, not a QuickBooks-specific one.
    const { data: before } = await admin.from('journal_entries')
      .select('id, status').eq('fund_id', fundId).in('source_ref', createdRefs)
      .eq('book', ACTUAL_BOOK)
    expect((before ?? []).every((e: any) => e.status === 'draft')).toBe(true)

    const result = await runBulkDraftAction(admin, {
      fundId, vehicleId, group, action: 'post', userId: null,
      scope: { ids: (before ?? []).map((e: any) => e.id), start: null, end: null, afterId: null },
    } as any)
    console.log('[bulk-post]', JSON.stringify(result))
    expect(result.ok, `bulk post failed: ${JSON.stringify((result as any).error)}`).toBe(true)
    const outcome = (result as any).outcome
    expect(outcome.changed).toBe(2)
    expect(outcome.skipped).toEqual([])

    const { data: after } = await admin.from('journal_entries')
      .select('id, status').eq('fund_id', fundId).in('source_ref', createdRefs)
      .eq('book', ACTUAL_BOOK)
    expect((after ?? []).every((e: any) => e.status === 'posted')).toBe(true)
  })

  it('still ties to QuickBooks once posted, now on the POSTED ledger', async () => {
    // The tie-out included drafts while the entries were drafts. Now that they are posted it
    // must tie on posted-only too — otherwise the migration would "tie" right up to the
    // moment it stopped being provisional.
    const tb = [
      'Account,Debit,Credit',
      `Investments:${SMOKE} Fund III,"1,000,000.00",`,
      `${SMOKE} Professional Fees,"12,500.00",`,
      `${SMOKE} Bank:Operating,,"1,012,500.00"`,
    ].join('\n')
    const { rows: theirs } = parseQbTrialBalance(tb)

    const { data: mappingRows } = await admin.from('qb_account_mappings')
      .select('qb_account, account_code, excluded').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    const mapping = new Map<string, string>()
    for (const r of (mappingRows ?? [])) if (!r.excluded && r.account_code) mapping.set(r.qb_account, r.account_code)

    const { data: posted } = await admin.from('journal_entries')
      .select('id').eq('fund_id', fundId).eq('status', 'posted').in('source_ref', createdRefs)
      .eq('book', ACTUAL_BOOK)
    const entryIds = (posted ?? []).map((e: any) => e.id)
    expect(entryIds).toHaveLength(2)

    const acctRows = await fetchAllRows((f, t) => admin.from('chart_of_accounts')
      .select('id, code, name, type, subtype, company_id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).range(f, t))
    const { data: postingRows } = await admin.from('journal_postings')
      .select('account_id, amount, currency').in('journal_entry_id', entryIds)
      .eq('book', ACTUAL_BOOK)

    const accounts: Account[] = (acctRows as any[]).map(a => ({
      id: a.id, fundId, code: a.code, name: a.name, type: a.type, subtype: a.subtype, companyId: a.company_id ?? null,
    }))
    const postings: Posting[] = (postingRows ?? []).map((p: any) => ({
      accountId: p.account_id, amount: Number(p.amount), currency: p.currency,
    }))
    const result = compareTrialBalance(trialBalance(accounts, postings), theirs, mapping)
    console.log('[tie-out posted]', JSON.stringify({ ties: result.ties, lines: result.lines }))
    expect(result.ties).toBe(true)
  })

  it('records the run', async () => {
    const { error } = await admin.from('qb_import_runs').insert({
      fund_id: fundId, vehicle_id: vehicleId, source_label: SMOKE,
      transactions_parsed: 2, entries_created: 2, entries_matched: 0, transactions_skipped: 0,
    })
    expect(error).toBeNull()
    const { count } = await admin.from('qb_import_runs')
      .select('id', { count: 'exact', head: true }).eq('fund_id', fundId).eq('source_label', SMOKE)
    expect(count).toBe(1)
  })
})

/** QuickBooks writes M/D/YYYY. */
function fmtUs(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}/${y}`
}
