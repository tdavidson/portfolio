// scripts/check-investment-ownership.mjs
//
// The investment-ownership backstop (supabase/migrations/20261009300000_investment_ownership_trigger.sql):
// no posted actual-book entry may carry a line on an investment account that no investment
// transaction owns. Applied from pending-deploy directly — it is tested before it moves, the way
// check-entity-access.mjs tested notes_entity_required.sql.
//
// Run through `npm run sql:check:accounting` (a throwaway cluster), or against PGlite with
// PGLITE_MODULE set, like the companion scripts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IDS, GROUP, applySchema, seedEntity, migrationSql, rejects } from './unified-accounting-sql-fixture.mjs'

async function openDb() {
  if (process.env.PG_MODULE) {
    const pg = await import(process.env.PG_MODULE)
    const Client = pg.Client ?? pg.default.Client
    const client = new Client({
      host: process.env.PGHOST, port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? 'postgres', database: process.env.PGDATABASE ?? 'postgres',
    })
    await client.connect()
    return { kind: 'postgres', query: (s, p) => client.query(s, p), exec: s => client.query(s), close: () => client.end() }
  }
  const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
  const db = new PGlite()
  return { kind: 'pglite', query: (s, p) => db.query(s, p), exec: s => db.exec(s), close: () => db.close() }
}

// The tables the unified fixture leaves out, with the real columns the trigger reads.
const OWNERSHIP_FIXTURE = `
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references funds(id) on delete cascade,
  name text not null default 'Company'
);
alter table public.chart_of_accounts add column company_id uuid references companies(id) on delete set null;
alter table public.journal_entries add column reversed_by uuid references journal_entries(id) on delete set null;
create table public.investment_transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  fund_id uuid not null references funds(id) on delete cascade,
  transaction_type text not null,
  transaction_date date,
  portfolio_group text,
  valuation_change_source text,
  constraint investment_transactions_valuation_change_source_check
    check (valuation_change_source is null or valuation_change_source in ('mark', 'fx'))
);
`
const STAGED = readFileSync(new URL('../supabase/migrations/20261009300000_investment_ownership_trigger.sql', import.meta.url), 'utf8')

const db = await openDb()
const i = IDS
const one = async (sql, params) => (await db.query(sql, params)).rows[0]

await applySchema(db)
await seedEntity(db)
await db.exec(OWNERSHIP_FIXTURE)
await db.exec(migrationSql('20261008100000_investment_adopted_entry.sql'))
await db.exec(migrationSql('20261008100001_valuation_change_source_quote_nav.sql'))
await db.exec(STAGED)

const co = (await one("insert into companies(fund_id, name) values ($1, 'Acme') returning id", [i.fund])).id
const account = async (code, type, subtype, companyId = null) => (await one(
  `insert into chart_of_accounts(fund_id, portfolio_group, vehicle_id, code, name, type, subtype, company_id)
   values ($1,$2,$3,$4,$4,$5,$6,$7) returning id`, [i.fund, GROUP, i.vehicle, code, type, subtype, companyId])).id
const cash = await account('1000', 'asset', 'cash')
const cost = await account('1100-acme', 'asset', 'investment', co)
const pooledCost = await account('1100', 'asset', 'investment')
const unrealizedIncome = await account('4200', 'income', 'unrealized')

/** A draft entry with its lines in ONE statement (the balance trigger is deferred to commit). */
async function entry(lines, { sourceRef = null, status = 'draft' } = {}) {
  const id = (await one(
    `insert into journal_entries(fund_id, portfolio_group, vehicle_id, entry_date, source_ref, status)
     values ($1,$2,$3,'2026-03-01',$4,$5) returning id`, [i.fund, GROUP, i.vehicle, sourceRef, status])).id
  const values = lines.map((_, n) => `($1,$2,$3,$4,$${n * 2 + 5},$${n * 2 + 6})`).join(', ')
  await db.query(`insert into journal_postings(fund_id, portfolio_group, vehicle_id, journal_entry_id, account_id, amount) values ${values}`,
    [i.fund, GROUP, i.vehicle, id, ...lines.flatMap(([a, amt]) => [a, amt])])
  return id
}
const post = id => db.query("update journal_entries set status = 'posted', posted_at = now() where id = $1", [id])
const txn = async (adoptedEntryId = null) => (await one(
  `insert into investment_transactions(company_id, fund_id, transaction_type, transaction_date, portfolio_group, adopted_entry_id)
   values ($1,$2,'investment','2026-03-01',$3,$4) returning id`, [co, i.fund, GROUP, adoptedEntryId])).id
const purchase = [[cost, 100], [cash, -100]]
const OWNS = /no investment transaction owns/

// 1. Unowned: refused.
const unowned = await entry(purchase)
await rejects('an unowned investment entry posts', () => post(unowned), OWNS)

// 2. Derived: owned through source_ref.
const t1 = await txn()
await post(await entry(purchase, { sourceRef: `txn:${t1}` }))

// 3. Adopted: owned through adopted_entry_id, inserted before the flip (persistEntry's order).
const adopted = await entry(purchase)
await txn(adopted)
await post(adopted)

// 4. A txn: reference to a transaction that does not exist is not ownership.
const dangling = await entry(purchase, { sourceRef: 'txn:00000000-0000-0000-0000-00000000dead' })
await rejects('a dangling txn: reference posts', () => post(dangling), OWNS)

// 5. A reversal pair is owned, even after the original's transaction is deleted.
const t2 = await txn()
const original = await entry(purchase, { sourceRef: `txn:${t2}` })
await post(original)
await db.query('delete from investment_transactions where id = $1', [t2])
const reversal = await entry([[cost, -100], [cash, 100]], { sourceRef: `reversal:${original}` })
await post(reversal)
await db.query('update journal_entries set reversed_by = $1 where id = $2', [reversal, original])
const second = await entry([[cost, -100], [cash, 100]], { sourceRef: `reversal:${original}` })
await rejects('a second reversal of an already-reversed entry', () => post(second), OWNS)

// 5b. A re-reversal after the earlier reversal was voided posts (reversed_by still points at the void one).
const t3 = await txn()
const orig2 = await entry(purchase, { sourceRef: `txn:${t3}` })
await post(orig2)
const rev1 = await entry([[cost, -100], [cash, 100]], { sourceRef: `reversal:${orig2}` })
await db.query("update journal_entries set status = 'void' where id = $1", [rev1])
await db.query('update journal_entries set reversed_by = $1 where id = $2', [rev1, orig2])
await post(await entry([[cost, -100], [cash, 100]], { sourceRef: `reversal:${orig2}` }))

// 5c. A malformed reference is "not owned", not a cast error.
const malformed = await entry(purchase, { sourceRef: 'txn:not-a-uuid' })
await rejects('a malformed txn: reference posts', () => post(malformed), OWNS)

// 5d. Moving an investment line from an owned posted entry onto an unowned posted entry is refused.
const t4 = await txn()
const ownedE = await entry(purchase, { sourceRef: `txn:${t4}` })
await post(ownedE)
const unownedE = await entry([[cash, 100], [i.capA, -100]])
await post(unownedE)
await rejects('moving an investment line onto an unowned posted entry', () => db.query(
  `update journal_postings set journal_entry_id = $1 where journal_entry_id = $2 and account_id = $3`, [unownedE, ownedE, cost]), OWNS)

// 6. The tax book is exempt; flipping a posted tax entry onto the actual book is not.
const taxEntry = await entry(purchase)
await db.query("update journal_entries set book = 'tax' where id = $1", [taxEntry])
await post(taxEntry)
await rejects('a tax entry moved onto the actual book', () => db.query("update journal_entries set book = 'actual' where id = $1", [taxEntry]), OWNS)

// 7. Income and cash only (pooled 4200 shares a subtype with 1200 but is income): allowed.
await post(await entry([[unrealizedIncome, -50], [cash, 50]]))

// 8. A pooled investment account is still an investment account.
await rejects('an unowned pooled 1100 entry', async () => post(await entry([[pooledCost, 100], [cash, -100]])), OWNS)

// 9. Legacy unowned posted entries stay editable on their other lines; no new investment line.
await db.query('alter table journal_entries disable trigger journal_entries_investment_owned')
await db.query('alter table journal_postings disable trigger journal_postings_investment_owned')
const legacy = await entry([[cost, 100], [i.capA, -100]], { status: 'posted' })
await db.query('alter table journal_entries enable trigger journal_entries_investment_owned')
await db.query('alter table journal_postings enable trigger journal_postings_investment_owned')
await db.query('update journal_postings set account_id = $1 where journal_entry_id = $2 and account_id = $3', [i.capB, legacy, i.capA])
await rejects('a new investment line on a legacy unowned entry', () => db.query(
  `insert into journal_postings(fund_id, portfolio_group, vehicle_id, journal_entry_id, account_id, amount)
   values ($1,$2,$3,$4,$5,10), ($1,$2,$3,$4,$6,-10)`, [i.fund, GROUP, i.vehicle, legacy, cost, cash]), OWNS)

// 10. Clients cannot call the functions.
for (const fn of ['public.is_investment_account(uuid)', 'public.investment_entry_owned(uuid,uuid,text)',
  'public.assert_investment_entry_owned()', 'public.assert_investment_posting_owned()']) {
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await one('select has_function_privilege($1,$2,$3) ok', [role, fn, 'execute'])).ok, false, `${role} must not execute ${fn}`)
  }
}

// 11. The widened valuation sources.
for (const source of ['mark', 'fx', 'quote', 'nav']) {
  await db.query(`insert into investment_transactions(company_id, fund_id, transaction_type, valuation_change_source)
    values ($1,$2,'unrealized_gain_change',$3)`, [co, i.fund, source])
}
await rejects('an unknown valuation source', () => db.query(`insert into investment_transactions(company_id, fund_id, transaction_type, valuation_change_source)
  values ($1,$2,'unrealized_gain_change','guess')`, [co, i.fund]), /valuation_change_source_check/)

console.log(`investment ownership SQL checks passed on ${db.kind}:
  unowned refused; derived, adopted, reversal pair and tax book allowed; dangling reference refused;
  tax → actual flip refused; income-only allowed; pooled refused; legacy entries editable without
  new investment lines; functions revoked; quote/nav valuation sources accepted`)
await db.close()
