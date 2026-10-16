/**
 * Writes demo-seed-call-history-2026.sql (and its -remove.sql): the capital call register for the
 * demo fund's history, which until now held only Fund I #8.
 *
 *   node scripts/demo-seed/generate-call-history.mjs
 *
 * The ledger already records every call (Fund I #1–#7, Fund II #1–#6) as cash straight into
 * partners' capital, with no Due from LPs receivable. This seed:
 *
 *   1. Registers each of those calls as an issued capital_calls row with its lines, linked to the
 *      journal entry it already has. Nothing is posted. complete_capital_operation checks each
 *      single-entry call's lines against the entry's capital postings, so a wrong amount fails the
 *      script instead of landing. #7 (Fund I) and #6 (Fund II) were booked as one wire entry per
 *      partner, so they carry no journal_entry_id and skip that check.
 *   2. Records each historical line as paid (settled_amount / settled_on, the wire date) and
 *      confirms, through review_capital_settlement, that the payment is separate from any Due from
 *      LPs receipt. Without that, a partner with a receipt against an open call would read
 *      "Payment reconciliation needed" on every line.
 *   3. Raises Fund I commitments from $12.0M to $14.0M pro rata, effective 15 Sep 2026, as a
 *      follow-on reserve with no fee on the increase. Before it, Fund I's calls ($12.7M with #8)
 *      exceeded its commitments. The increase keeps every partner's share, so allocations and the
 *      "2% of $12.0M" fee wording stay right.
 *   4. Numbers Fund I's open call (#8, from demo-seed-calls-2026).
 *   5. Issues Fund II #7, its final $300K, the way the app issues a call (draft entry, draft
 *      register row, complete_capital_operation), with one partner paid and the rest not yet due.
 *
 * Every row is tagged: capital_calls.request_key starts with the tag, journal entries carry it as
 * source_ref, and the commitment events have fixed ids. The remove file takes all of it out.
 * Account ids are looked up by code in the SQL, so no database access is needed to generate it.
 */
import { createHash } from 'crypto'
import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const FUND = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' // Hemrock Ventures, the demo fund
const ADMIN = 'e95bae2f-0a73-483c-9e9c-f64992e8054a' // the demo fund's admin, recorded as reviewer
const TAG = 'demo-seed-call-history-2026'
const HERE = dirname(fileURLToPath(import.meta.url))

const FUND_I = { group: 'Fund I', vehicle: '061ee98b-cea1-465e-a73c-d597df4afaba' }
const FUND_II = { group: 'Fund II', vehicle: 'd73f3df5-5a2f-4c34-b431-e6c8d71fd4e9' }

const LP = {
  founders: '284cb747-2354-4cf1-8018-548eb5eac0f3',
  coastal: '278ec0e3-2940-46f6-b651-5775726f9560',
  northstarI: '7888b510-c3cf-40ab-b40a-586623662b83',
  pinecrest: 'a2636fbe-5a1e-4bf1-a600-c1d5e28631d5',
  angelsI: 'fcfff8e9-f323-497e-bcf1-15d2979a3a82',
  northstarII: 'ed542a37-1fc6-4c19-bce8-992413009631',
  greenfield: '6a657357-5f5d-416f-81f3-35815df4ae69',
  angelsII: '4f57aefa-a42b-4293-9162-6b849f592dc8',
}

// Stable ids, so regenerating gives the same file and the remove file can name rows.
const id = (...parts) => {
  const h = createHash('sha1').update([TAG, ...parts].join(':')).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
const minusDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}
const q = v => (v === null || v === undefined ? 'null' : typeof v === 'number' ? v.toFixed(2) : `'${String(v).replace(/'/g, "''")}'`)
const json = v => `${q(JSON.stringify(v))}::jsonb`
const purpose = (category, amount, description, basis = null) => ({ category, amount, description, basis, date: null })
const reserve = amount => purpose('other', amount, 'Reserve for fees and fund expenses')

// The history, exactly as the ledger has it. `paidOn` is the ledger date (cash in); the notice
// went out 10 days earlier, matching the 10-day notice period on both vehicles. `entry` is the
// call's journal entry, or null where the ledger has one wire entry per partner instead.
const HISTORY = [
  { v: FUND_I, n: 1, paidOn: '2022-03-15', entry: 'df350a32-37ce-4802-b02f-7a3397e037c9', description: 'RouteWise Seed and fee reserve',
    purposes: [purpose('investment', 400000, 'RouteWise Seed'), reserve(100000)],
    lines: { coastal: 104166.67, founders: 166666.66, northstarI: 125000, pinecrest: 62500, angelsI: 41666.67 } },
  { v: FUND_I, n: 2, paidOn: '2023-06-10', entry: '7ea8ff95-0102-4758-97e9-cfb3cef2ea8b', description: 'NovaTech Seed, RouteWise Series A and fees',
    purposes: [purpose('investment', 500000, 'NovaTech Seed'), purpose('investment', 1000000, 'RouteWise Series A'), purpose('management_fee', 300000, 'Management fees')],
    lines: { coastal: 375000, founders: 600000, northstarI: 450000, pinecrest: 225000, angelsI: 150000 } },
  { v: FUND_I, n: 3, paidOn: '2024-01-05', entry: '4b6e4aeb-f5ab-4530-909d-6475aad1f947', description: 'GreenLeaf Bio Seed and reserves',
    purposes: [purpose('investment', 750000, 'GreenLeaf Bio Seed'), reserve(250000)],
    lines: { coastal: 208333.33, founders: 333333.34, northstarI: 250000, pinecrest: 125000, angelsI: 83333.33 } },
  { v: FUND_I, n: 4, paidOn: '2024-06-01', entry: '69037c3d-b07a-4851-bfee-16489224ec9b', description: 'AdVantage Series A and reserves',
    purposes: [purpose('investment', 2000000, 'AdVantage Series A'), reserve(500000)],
    lines: { coastal: 520833.33, founders: 833333.34, northstarI: 625000, pinecrest: 312500, angelsI: 208333.33 } },
  { v: FUND_I, n: 5, paidOn: '2024-09-01', entry: '4d5ead5b-f611-4f24-b701-219c74d0c866', description: 'NovaTech Series A follow-on and reserves',
    purposes: [purpose('investment', 1500000, 'NovaTech Series A'), reserve(500000)],
    lines: { coastal: 416666.67, founders: 666666.66, northstarI: 500000, pinecrest: 250000, angelsI: 166666.67 } },
  { v: FUND_I, n: 6, paidOn: '2024-11-01', entry: 'ecc6a197-0f44-4472-b9d3-00c81befdada', description: 'RouteWise Series B and reserves',
    purposes: [purpose('investment', 2000000, 'RouteWise Series B'), reserve(500000)],
    lines: { coastal: 520833.33, founders: 833333.34, northstarI: 625000, pinecrest: 312500, angelsI: 208333.33 } },
  { v: FUND_I, n: 7, paidOn: '2026-01-20', entry: null, description: 'NovaTech Series B and reserves',
    purposes: [purpose('investment', 1000000, 'NovaTech Series B'), reserve(200000)],
    lines: { coastal: 250000, founders: 400000, northstarI: 300000, pinecrest: 150000, angelsI: 100000 } },

  { v: FUND_II, n: 1, paidOn: '2022-01-10', entry: '904925f2-03f2-47eb-921c-84b9b04ed5a1', description: 'Benchline Seed and fee reserve',
    purposes: [purpose('investment', 300000, 'Benchline Seed'), reserve(200000)],
    lines: { coastal: 75000, founders: 175000, angelsII: 25000, greenfield: 100000, northstarII: 125000 } },
  { v: FUND_II, n: 2, paidOn: '2023-04-01', entry: 'e2dada2f-6cf9-4900-8027-ad0872a54a33', description: 'Benchline Series A, TapFin Seed and fees',
    purposes: [purpose('investment', 1200000, 'Benchline Series A'), purpose('investment', 350000, 'TapFin Seed'), purpose('management_fee', 250000, 'Management fees')],
    lines: { coastal: 270000, founders: 630000, angelsII: 90000, greenfield: 360000, northstarII: 450000 } },
  { v: FUND_II, n: 3, paidOn: '2024-04-15', entry: '3cacf67c-2559-4f65-a79f-3ea2a95bec92', description: 'Verdant Seed and reserves',
    purposes: [purpose('investment', 600000, 'Verdant Seed'), reserve(600000)],
    lines: { coastal: 180000, founders: 420000, angelsII: 60000, greenfield: 240000, northstarII: 300000 } },
  { v: FUND_II, n: 4, paidOn: '2024-08-01', entry: 'be144b1b-f128-4782-95f5-8fdaf47fdb1e', description: 'Benchline Series B, Lattis Pre-Seed and reserves',
    purposes: [purpose('investment', 2500000, 'Benchline Series B'), purpose('investment', 250000, 'Lattis Pre-Seed'), reserve(450000)],
    lines: { coastal: 480000, founders: 1120000, angelsII: 160000, greenfield: 640000, northstarII: 800000 } },
  { v: FUND_II, n: 5, paidOn: '2024-12-01', entry: '28e50476-bdbb-4224-a450-20c054d0dd1f', description: 'TapFin Series A and reserves',
    purposes: [purpose('investment', 1500000, 'TapFin Series A'), reserve(300000)],
    lines: { coastal: 270000, founders: 630000, angelsII: 90000, greenfield: 360000, northstarII: 450000 } },
  { v: FUND_II, n: 6, paidOn: '2026-02-10', entry: null, description: 'Benchline Series C and Verdant bridge',
    purposes: [purpose('investment', 900000, 'Benchline Series C'), purpose('investment', 300000, 'Verdant bridge note (with cash on hand)')],
    lines: { coastal: 180000, founders: 420000, angelsII: 60000, greenfield: 240000, northstarII: 300000 } },
]

// Fund I's commitment increase: +$2.0M in the partners' existing shares (4 : 3 : 2.5 : 1.5 : 1 of 12).
const INCREASE_DATE = '2026-09-15'
const INCREASE = { founders: 666666.66, northstarI: 500000, coastal: 416666.67, pinecrest: 250000, angelsI: 166666.67 }

// Fund II #7: the last $300K of its $10.0M, pro rata. Founders has paid; the rest are not yet due.
const CALL7 = {
  date: '2026-10-09', due: '2026-10-19', description: 'Q4 2026 management fee and follow-on reserve',
  purposes: [purpose('management_fee', 50000, 'Q4 2026 management fee', '2% of $10.0M commitments, Q4 2026'), purpose('investment', 250000, 'Follow-on reserve: Lattis and Verdant')],
  lines: { founders: 105000, northstarII: 75000, greenfield: 60000, coastal: 45000, angelsII: 15000 },
  paid: [{ lp: 'founders', amount: 105000, on: '2026-10-13' }],
}

const NAMES = {
  founders: 'Hemrock Founders Capital LP', coastal: 'Coastal University Endowment', northstarI: 'Northstar Family Office I LLC',
  pinecrest: 'Pinecrest Foundation Charitable Trust', angelsI: 'Hemrock Angels Aggregator I LP', northstarII: 'Northstar Family Office II LLC',
  greenfield: 'Greenfield County Employees Pension', angelsII: 'Hemrock Angels Aggregator II LP',
}

const account = (v, code) => `(select id from chart_of_accounts where fund_id = ${q(FUND)} and vehicle_id = ${q(v.vehicle)} and code = ${q(code)})`
const capitalAccount = (v, lp) => `(select id from chart_of_accounts where fund_id = ${q(FUND)} and vehicle_id = ${q(v.vehicle)} and lp_entity_id = ${q(lp)} and type = 'equity' and subtype = 'lp_capital')`
const linesJson = lines => json(Object.entries(lines).map(([k, amount]) => ({ lpEntityId: LP[k], amount })))
const total = lines => Math.round(Object.values(lines).reduce((s, a) => s + a, 0) * 100) / 100

const sql = []
const add = s => sql.push(s)

for (const c of HISTORY) {
  const sum = c.purposes.reduce((s, p) => s + p.amount, 0)
  if (Math.abs(sum - total(c.lines)) > 0.005) throw new Error(`${c.v.group} #${c.n}: purposes ${sum} ≠ lines ${total(c.lines)}`)
}
for (const v of [FUND_I, FUND_II]) {
  const t = HISTORY.filter(c => c.v === v).reduce((s, c) => s + total(c.lines), 0)
  console.log(`${v.group}: ${HISTORY.filter(c => c.v === v).length} historical calls, ${t.toFixed(2)}`)
}

add('-- 1. The call history, registered against the entries the ledger already has. Nothing is posted.')
for (const c of HISTORY) {
  const callId = id(c.v.group, 'call', c.n)
  const callDate = minusDays(c.paidOn, 10)
  add(`-- ${c.v.group} #${c.n}: ${c.description}.`)
  add(`insert into capital_calls (id, fund_id, vehicle_id, request_key, call_date, due_date, call_number, description, scope, status, journal_entry_id, purposes, created_by) values (${[
    q(callId), q(FUND), q(c.v.vehicle), q(`${TAG}:${c.v.group}:${c.n}`), q(callDate), q(c.paidOn), String(c.n), q(c.description),
    q('fund_wide'), q('issued'), q(c.entry), json(c.purposes), q(ADMIN)].join(', ')});`)
  for (const [k, amount] of Object.entries(c.lines)) {
    add(`insert into capital_call_lines (id, call_id, fund_id, vehicle_id, lp_entity_id, amount, settled_amount, settled_on) values (${[
      q(id(c.v.group, 'line', c.n, k)), q(callId), q(FUND), q(c.v.vehicle), q(LP[k]), q(amount), q(amount), q(c.paidOn)].join(', ')});`)
  }
  if (c.entry) {
    add(`select public.complete_capital_operation(p_fund_id => ${q(FUND)}, p_vehicle_id => ${q(c.v.vehicle)}, p_kind => 'call', p_register_id => ${q(callId)}, p_entry_ids => array[${q(c.entry)}::uuid], p_lines => ${linesJson(c.lines)});`)
  }
  for (const k of Object.keys(c.lines)) {
    add(`select public.review_capital_settlement(${q(FUND)}, ${q(c.v.vehicle)}, 'call', ${q(id(c.v.group, 'line', c.n, k))}, '[]'::jsonb, true, ${q(ADMIN)});`)
  }
}

add('')
add(`-- 2. Fund I commitments from $12.0M to $14.0M, in the partners' existing shares.`)
for (const [k, amount] of Object.entries(INCREASE)) {
  add(`insert into commitment_events (id, fund_id, vehicle_id, lp_entity_id, effective_date, amount, kind, memo, created_by) values (${[
    q(id('Fund I', 'increase', k)), q(FUND), q(FUND_I.vehicle), q(LP[k]), q(INCREASE_DATE), q(amount), q('increase'),
    q('Commitment increase for follow-on reserves; no management fee on the increase'), q(ADMIN)].join(', ')});`)
}

add('')
add('-- 3. Fund I\'s open call is #8.')
add(`update capital_calls set call_number = 8 where fund_id = ${q(FUND)} and vehicle_id = ${q(FUND_I.vehicle)} and request_key = 'demo-seed-calls-2026';`)

add('')
add(`-- 4. Fund II #7, its final call: issued ${CALL7.date}, due ${CALL7.due}, issued the way the app issues one.`)
{
  const v = FUND_II
  const entryId = id(v.group, 'entry', 7), callId = id(v.group, 'call', 7)
  const memo = 'Capital call #7 — Q4 2026 fee and follow-on reserve'
  const entry = (eid, date, m, sourceType, status) =>
    add(`insert into journal_entries (id, fund_id, portfolio_group, vehicle_id, entry_date, memo, source_type, source_ref, status, posted_at, book) values (${[
      q(eid), q(FUND), q(v.group), q(v.vehicle), q(date), q(m), q(sourceType), q(TAG), q(status), status === 'posted' ? q(`${date}T17:00:00Z`) : 'null', q('actual')].join(', ')});`)
  const posting = (eid, accountSql, amount, lp) =>
    add(`insert into journal_postings (fund_id, portfolio_group, vehicle_id, journal_entry_id, account_id, amount, lp_entity_id, book) values (${[
      q(FUND), q(v.group), q(v.vehicle), q(eid), accountSql, q(amount), q(lp), q('actual')].join(', ')});`)

  entry(entryId, CALL7.date, memo, 'capital_call', 'draft')
  for (const [k, amount] of Object.entries(CALL7.lines)) {
    posting(entryId, account(v, '1300'), amount, LP[k])
    posting(entryId, capitalAccount(v, LP[k]), -amount, LP[k])
  }
  add(`insert into capital_calls (id, fund_id, vehicle_id, request_key, call_date, due_date, call_number, description, scope, status, journal_entry_id, purposes, created_by) values (${[
    q(callId), q(FUND), q(v.vehicle), q(`${TAG}:${v.group}:7`), q(CALL7.date), q(CALL7.due), '7', q(CALL7.description),
    q('fund_wide'), q('draft'), q(entryId), json(CALL7.purposes), q(ADMIN)].join(', ')});`)
  add(`select public.complete_capital_operation(p_fund_id => ${q(FUND)}, p_vehicle_id => ${q(v.vehicle)}, p_kind => 'call', p_register_id => ${q(callId)}, p_entry_ids => array[${q(entryId)}::uuid], p_lines => ${linesJson(CALL7.lines)});`)
  for (const p of CALL7.paid) {
    const fid = id(v.group, 'funding', 7, p.lp)
    entry(fid, p.on, `Capital call #7 — wire from ${NAMES[p.lp]}`, 'contribution_funding', 'posted')
    posting(fid, account(v, '1000'), p.amount, null)
    posting(fid, account(v, '1300'), -p.amount, LP[p.lp])
  }
}

const header = [
  `-- ${TAG}: the capital call register for the demo fund's history, a Fund I commitment increase that`,
  '-- covers what Fund I has called, and Fund II\'s final call (#7). Run after demo-seed-calls-forecast-2026.sql',
  '-- and demo-seed-oct-2026.sql, in the Supabase SQL editor, then re-record the demo.',
  '-- GENERATED by scripts/demo-seed/generate-call-history.mjs; regenerate rather than edit.',
  `-- ${TAG}-remove.sql takes it all out.`,
]
writeFileSync(join(HERE, `${TAG}.sql`), [...header, 'begin;', ...sql, 'commit;', ''].join('\n'))

const calls = `(select id from capital_calls where fund_id = ${q(FUND)} and request_key like '${TAG}:%')`
writeFileSync(join(HERE, `${TAG}-remove.sql`), [
  `-- Removes ${TAG}: the settlement reviews, lines and calls it registered, Fund II #7's entries`,
  '-- (postings cascade), the Fund I commitment increase, and Fund I #8\'s number.',
  'begin;',
  `delete from capital_settlement_reviews where fund_id = ${q(FUND)} and kind = 'call' and line_id in (select id from capital_call_lines where call_id in ${calls});`,
  `delete from capital_call_lines where call_id in ${calls};`,
  `delete from capital_calls where fund_id = ${q(FUND)} and request_key like '${TAG}:%';`,
  `delete from journal_entries where fund_id = ${q(FUND)} and source_ref = ${q(TAG)};`,
  `delete from commitment_events where id in (${Object.keys(INCREASE).map(k => q(id('Fund I', 'increase', k))).join(', ')});`,
  `update capital_calls set call_number = null where fund_id = ${q(FUND)} and vehicle_id = ${q(FUND_I.vehicle)} and request_key = 'demo-seed-calls-2026';`,
  'commit;',
  '',
].join('\n'))
console.log(`Wrote ${sql.length} statements to scripts/demo-seed/${TAG}.sql`)
