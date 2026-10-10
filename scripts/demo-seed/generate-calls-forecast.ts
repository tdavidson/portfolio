/**
 * Writes demo-seed-calls-forecast-2026.sql (and its -remove.sql): one open capital call on the
 * demo fund's Fund I with every kind of standing a capital-call dashboard shows, and a rolling
 * forecast for Fund I. Without --apply it only READS the database: it looks up the demo fund's account and
 * partner ids and writes SQL for a person to review and run.
 *
 *   npx tsx --env-file=.env.local scripts/demo-seed/generate-calls-forecast.ts            # writes the SQL
 *   npx tsx --env-file=.env.local scripts/demo-seed/generate-calls-forecast.ts --apply    # and applies it
 *   npx tsx --env-file=.env.local scripts/demo-seed/generate-calls-forecast.ts --remove   # takes it out
 *
 * The call is built the way the app builds one (lib/accounting/capital-calls.ts issueCapitalCall):
 * a draft entry from buildCapitalCallIssuanceEntry, a draft register row, then the database's own
 * complete_capital_operation, which writes the lines and posts the entry. Payments are
 * buildFundingEntry entries (cash against Due from LPs), as recording a receipt posts them. One
 * partner has only said they wired, from the portal: an acknowledgment on their line, no money.
 *
 * The forecast is a plan and its rules. A plan's figures are compiled by the app on save, which the
 * read-only demo viewer cannot do: after running the SQL, open Fund I → Forecast as an admin of the
 * demo fund and click Refresh once, then re-record the demo.
 */
import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { buildCapitalCallIssuanceEntry, buildFundingEntry } from '@/lib/accounting/entries'

const FUND = 'e2dfd2bf-ced3-4647-8277-096e616a6eab'   // Hemrock Ventures, the demo fund
const VEHICLE = '061ee98b-cea1-465e-a73c-d597df4afaba' // Fund I
const GROUP = 'Fund I'
const TAG = 'demo-seed-calls-2026'
const CALL_DATE = '2026-10-01'
const DUE_DATE = '2026-10-08'

// Each partner's share of the call and how it stands: the dashboard's every state, once.
const PLAN: { name: string; amount: number; paid?: { amount: number; on: string }; saysWired?: { on: string; reference: string } }[] = [
  { name: 'Hemrock Founders Capital LP', amount: 400000, paid: { amount: 400000, on: '2026-10-05' } },
  { name: 'Northstar Family Office I LLC', amount: 300000, paid: { amount: 300000, on: '2026-10-06' } },
  { name: 'Coastal University Endowment', amount: 250000, paid: { amount: 125000, on: '2026-10-07' } },
  { name: 'Pinecrest Foundation Charitable Trust', amount: 150000, saysWired: { on: '2026-10-07', reference: 'FW-2610-0447' } },
  { name: 'Hemrock Angels Aggregator I LP', amount: 100000 },
]

const q = (v: unknown): string => (v === null || v === undefined ? 'null' : typeof v === 'number' ? v.toFixed(2) : `'${String(v).replace(/'/g, "''")}'`)

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: accounts, error } = await db.from('chart_of_accounts').select('id, code, name, lp_entity_id').eq('fund_id', FUND).eq('vehicle_id', VEHICLE)
  if (error || !accounts) throw new Error(`chart_of_accounts: ${error?.message}`)
  const byCode = (code: string) => {
    const a = accounts.find(x => x.code === code)
    if (!a) throw new Error(`Fund I has no account ${code}`)
    return a.id as string
  }
  const capital = new Map<string, string>()   // lp entity → its capital account
  const entityByName = new Map<string, string>()
  for (const a of accounts) {
    if (!a.lp_entity_id) continue
    capital.set(a.lp_entity_id, a.id)
    entityByName.set(String(a.name).replace(/^Partners' capital — /, ''), a.lp_entity_id)
  }
  const lp = (name: string) => {
    const id = entityByName.get(name)
    if (!id) throw new Error(`No Fund I partner named ${name}`)
    return id
  }
  const cash = byCode('1000'), receivable = byCode('1300')

  // Every write, once: rendered as SQL for review, or applied (--apply) through the service-role
  // client in the same order, stopping on the first error.
  type Op =
    | { kind: 'insert'; table: string; rows: Record<string, unknown>[] }
    | { kind: 'rpc'; fn: string; args: Record<string, unknown> }
    | { kind: 'update'; table: string; set: Record<string, unknown>; match: Record<string, unknown> }
    | { kind: 'comment'; text: string }
  const ops: Op[] = []
  const val = (v: unknown) => (v !== null && typeof v === 'object' ? `${q(JSON.stringify(v))}::jsonb` : q(v))
  const ins = (table: string, ...rows: Record<string, unknown>[]) => ops.push({ kind: 'insert', table, rows })
  const entry = (id: string, date: string, memo: string, sourceType: string, status: 'draft' | 'posted', postings: { accountId: string; amount: number; lpEntityId?: string | null }[]) => {
    ins('journal_entries', { id, fund_id: FUND, portfolio_group: GROUP, vehicle_id: VEHICLE, entry_date: date, memo, source_type: sourceType, source_ref: TAG, status, posted_at: status === 'posted' ? `${date}T17:00:00Z` : null, book: 'actual' })
    ins('journal_postings', ...postings.map(p => ({ fund_id: FUND, portfolio_group: GROUP, vehicle_id: VEHICLE, journal_entry_id: id, account_id: p.accountId, amount: p.amount, lp_entity_id: p.lpEntityId ?? null, book: 'actual' })))
  }

  // 1. The call: draft entry + draft register row, published by the database's own function.
  const perLp = new Map(PLAN.map(p => [lp(p.name), p.amount]))
  const issuance = buildCapitalCallIssuanceEntry({ fundId: FUND, entryDate: CALL_DATE, memo: 'Capital call #8 — follow-ons and Q4 fees' }, perLp, capital, receivable)
  const issuanceId = randomUUID(), callId = randomUUID()
  ops.push({ kind: 'comment', text: 'Capital call #8: issued 1 Oct, due 8 Oct.' })
  entry(issuanceId, CALL_DATE, 'Capital call #8 — follow-ons and Q4 fees', 'capital_call', 'draft', issuance.postings)
  ins('capital_calls', { id: callId, fund_id: FUND, vehicle_id: VEHICLE, request_key: TAG, call_date: CALL_DATE, due_date: DUE_DATE, description: 'Follow-ons and Q4 fees', scope: 'fund_wide', status: 'draft', journal_entry_id: issuanceId })
  ops.push({ kind: 'rpc', fn: 'complete_capital_operation', args: {
    p_fund_id: FUND, p_vehicle_id: VEHICLE, p_kind: 'call', p_register_id: callId, p_entry_ids: [issuanceId],
    p_lines: PLAN.map(p => ({ lpEntityId: lp(p.name), amount: p.amount })),
  } })

  // 2. What has arrived: cash against Due from LPs, per partner.
  ops.push({ kind: 'comment', text: 'Receipts against the call.' })
  for (const p of PLAN.filter(x => x.paid)) {
    const funding = buildFundingEntry({ fundId: FUND, entryDate: p.paid!.on, memo: `Capital call #8 — wire from ${p.name}` }, lp(p.name), p.paid!.amount, cash, receivable)
    entry(randomUUID(), p.paid!.on, `Capital call #8 — wire from ${p.name}`, 'contribution_funding', 'posted', funding.postings)
  }

  // 3. A partner's own word, from the portal: no money yet.
  for (const p of PLAN.filter(x => x.saysWired)) {
    ops.push({ kind: 'update', table: 'capital_call_lines', set: { ack_at: `${p.saysWired!.on}T15:30:00Z`, ack_wired_on: p.saysWired!.on, ack_reference: p.saysWired!.reference }, match: { call_id: callId, lp_entity_id: lp(p.name) } })
  }

  // 4. A rolling forecast for Fund I: fees and expenses from the books' pattern, interest on cash.
  const planId = randomUUID()
  ops.push({ kind: 'comment', text: 'Rolling forecast for Fund I. Compile it once from the app (Forecast → Refresh) as an admin.' })
  ins('forecast_plans', { id: planId, fund_id: FUND, vehicle_id: VEHICLE, kind: 'rolling_forecast', name: 'Fund I — rolling 12', scenario: 'Base', start_month: '2026-10-01', end_month: '2027-09-01', horizon_months: 12, seed: { demo_seed: TAG } })
  const rule = (code: string, method: string, params: object, note: string) =>
    ins('forecast_rules', { plan_id: planId, fund_id: FUND, vehicle_id: VEHICLE, account_id: byCode(code), method, params, source: 'seeded', note })
  rule('5000', 'recurring', { amount: 60000, everyMonths: 3, anchor: '2026-10' }, 'Quarterly management fee, paid at the start of each quarter.')
  rule('5100', 'recurring', { amount: 12500, everyMonths: 3, anchor: '2026-10' }, 'Fund administration, billed quarterly.')
  rule('4100', 'run_rate', { window: 6 }, 'Interest on the sweep account, at its recent run rate.')

  const sql: string[] = []
  for (const op of ops) {
    if (op.kind === 'comment') sql.push(`-- ${op.text}`)
    else if (op.kind === 'insert') for (const row of op.rows) sql.push(`insert into ${op.table} (${Object.keys(row).join(', ')}) values (${Object.values(row).map(val).join(', ')});`)
    else if (op.kind === 'rpc') sql.push(`select public.${op.fn}(${Object.entries(op.args).map(([k, v]) => `${k} => ${Array.isArray(v) && v.every(x => typeof x === 'string') ? `array[${v.map(x => `${q(x)}::uuid`).join(', ')}]` : val(v)}`).join(', ')});`)
    else sql.push(`update ${op.table} set ${Object.entries(op.set).map(([k, v]) => `${k} = ${val(v)}`).join(', ')} where ${Object.entries(op.match).map(([k, v]) => `${k} = ${val(v)}`).join(' and ')};`)
  }

  const header = [
    `-- ${TAG}: an open capital call (#8) on the demo fund's Fund I, with a partner in every standing`,
    '-- (paid, partly paid, says wired, unpaid, overdue), and a rolling forecast for Fund I.',
    '-- GENERATED by scripts/demo-seed/generate-calls-forecast.ts from the demo fund\'s live account ids;',
    '-- regenerate rather than edit. Every row is tagged (journal_entries.source_ref, capital_calls.request_key,',
    `-- forecast_plans.seed->>'demo_seed' = '${TAG}'); demo-seed-calls-forecast-2026-remove.sql takes it out.`,
    '-- After running: open Fund I → Forecast as a demo-fund admin and click Refresh, then re-record the demo.',
  ]
  writeFileSync(join(__dirname, 'demo-seed-calls-forecast-2026.sql'), [...header, 'begin;', ...sql, 'commit;', ''].join('\n'))
  writeFileSync(join(__dirname, 'demo-seed-calls-forecast-2026-remove.sql'), [
    `-- Removes ${TAG}: the forecast plan (its rules, versions and compiled entries cascade), the call`,
    '-- and its lines, and every journal entry the seed wrote (postings cascade).',
    'begin;',
    `delete from forecast_plans where fund_id = ${q(FUND)} and seed->>'demo_seed' = ${q(TAG)};`,
    `delete from capital_call_lines where call_id in (select id from capital_calls where fund_id = ${q(FUND)} and request_key = ${q(TAG)});`,
    `delete from capital_calls where fund_id = ${q(FUND)} and request_key = ${q(TAG)};`,
    `delete from journal_entries where fund_id = ${q(FUND)} and source_ref = ${q(TAG)};`,
    'commit;',
    '',
  ].join('\n'))
  console.log(`Wrote ${sql.length} statements to scripts/demo-seed/demo-seed-calls-forecast-2026.sql`)

  if (!process.argv.includes('--apply')) return
  // Refuse to seed twice: the call's request key is unique per vehicle anyway.
  const { data: existing } = await db.from('capital_calls').select('id').eq('fund_id', FUND).eq('request_key', TAG)
  if (existing?.length) { console.log('Already applied; run with --remove first to re-seed.'); return }
  try {
    for (const op of ops) {
      if (op.kind === 'comment') continue
      const { error } = op.kind === 'insert' ? await db.from(op.table).insert(op.rows)
        : op.kind === 'rpc' ? await db.rpc(op.fn, op.args)
        : await Object.entries(op.match).reduce((b: any, [k, v]) => b.eq(k, v), db.from(op.table).update(op.set))
      if (error) throw new Error(`${op.kind} ${'table' in op ? op.table : op.fn}: ${error.message}`)
    }
    console.log('Applied.')
  } catch (e) {
    console.error(`Failed, removing what was written: ${(e as Error).message}`)
    await remove(db)
    process.exit(1)
  }
}

/** The remove file, through the client: plan (rules cascade), lines, call, entries (postings cascade). */
async function remove(db: any) {
  await db.from('forecast_plans').delete().eq('fund_id', FUND).eq('seed->>demo_seed', TAG)
  const { data: calls } = await db.from('capital_calls').select('id').eq('fund_id', FUND).eq('request_key', TAG)
  const ids = (calls ?? []).map((c: any) => c.id)
  if (ids.length) {
    await db.from('capital_call_lines').delete().in('call_id', ids)
    await db.from('capital_calls').delete().in('id', ids)
  }
  await db.from('journal_entries').delete().eq('fund_id', FUND).eq('source_ref', TAG)
}

if (process.argv.includes('--remove')) {
  remove(createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)).then(() => console.log('Removed.'))
} else {
  main().catch(e => { console.error(e); process.exit(1) })
}
