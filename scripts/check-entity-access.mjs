// Entity-level access, checked against a real PostgreSQL server.
//
//   node scripts/check-entity-access.mjs
//
// Starts a throwaway cluster (PostgreSQL binaries on PATH — `brew install postgresql@17`), builds
// the slice of the Supabase schema the entity-access migrations touch, applies those migrations
// verbatim, and asserts what a member can and cannot see. Nothing here ships; no network, no Docker.
//
// The stub schema mirrors: 20260710000000_fund_vehicles.sql, 20260716000008_member_access_grants.sql,
// 20260716000009_access_context_rpc.sql. `auth.uid()` reads `request.jwt.claim.sub`, as Supabase's does.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const WORK = process.env.ENTITY_SQL_WORKDIR ?? '/tmp/entsql'
const PORT = process.env.ENTITY_SQL_PORT ?? '55450'
const DATA = join(WORK, 'data')
const MIGRATIONS = (process.env.ENTITY_MIGRATIONS ?? [
  '20260716000009_access_context_rpc.sql',
  '20261007100000_entity_access_grants.sql',
  '20261007100100_company_vehicles.sql',
].join(',')).split(',')

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' })
const psql = (sql, { as } = {}) => {
  const prefix = as
    ? `set role authenticated; select set_config('request.jwt.claim.sub', '${as}', false);`
    : ''
  return execFileSync('psql', ['-h', WORK, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-qtA', '-c', prefix + sql], { stdio: 'pipe' }).toString().trim().split('\n').pop()
}
const applyFile = file => execFileSync('psql', ['-h', WORK, '-p', PORT, '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], { stdio: 'pipe' })

const STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create table funds (id uuid primary key default gen_random_uuid());
create table fund_members (fund_id uuid references funds(id), user_id uuid unique references auth.users(id), role text not null);
create table fund_settings (fund_id uuid primary key references funds(id), feature_visibility jsonb);
create table fund_member_access (fund_id uuid, user_id uuid, domain text, level text, primary key (fund_id, user_id, domain));
create table fund_domain_defaults (fund_id uuid, domain text, level text, primary key (fund_id, domain));
create table fund_vehicles (id uuid primary key default gen_random_uuid(), fund_id uuid not null references funds(id) on delete cascade,
  name text not null, kind text not null default 'fund', aliases text[] not null default '{}', active boolean not null default true,
  unique (fund_id, name));
create table companies (id uuid primary key default gen_random_uuid(), fund_id uuid not null references funds(id),
  name text not null, holding_type text not null default 'company', portfolio_group text[]);
create table investment_transactions (id uuid primary key default gen_random_uuid(), fund_id uuid not null,
  company_id uuid not null references companies(id) on delete cascade, portfolio_group text, transaction_type text);
create table chart_of_accounts (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid,
  company_id uuid references companies(id) on delete set null, code text not null);
create table fund_holding_terms (company_id uuid primary key references companies(id) on delete cascade, fund_id uuid not null, vehicle_id uuid);
create table crypto_wallets (id uuid primary key default gen_random_uuid(), fund_id uuid not null,
  company_id uuid not null references companies(id) on delete cascade, portfolio_group text, address text not null);
create table inbound_deals (id uuid primary key default gen_random_uuid(), fund_id uuid not null references funds(id));
grant select on all tables in schema public to authenticated;
`

const F = '00000000-0000-0000-0000-00000000000f'
const OTHER_F = '00000000-0000-0000-0000-0000000000ff'
const ADMIN = '00000000-0000-0000-0000-0000000000a1'
const MEMBER = '00000000-0000-0000-0000-0000000000b1'
const LATE = '00000000-0000-0000-0000-0000000000c1'
const V1 = '00000000-0000-0000-0000-000000000101'
const V2 = '00000000-0000-0000-0000-000000000102'
const VX = '00000000-0000-0000-0000-000000000109'

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    expected: ${expected}\n    actual:   ${actual}`}`)
}
const sortedIds = expr => `(select coalesce(string_agg(x::text, ',' order by x::text), '') from unnest(${expr}) x)`

let started = false
try {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  run('initdb', ['-D', DATA, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'])
  run('pg_ctl', ['-D', DATA, '-l', join(WORK, 'log'), '-o', `-k ${WORK} -p ${PORT} -c listen_addresses=''`, '-w', 'start'])
  started = true

  psql(STUB)
  psql(`insert into auth.users values ('${ADMIN}'), ('${MEMBER}'), ('${LATE}');
        insert into funds values ('${F}'), ('${OTHER_F}');
        insert into fund_members values ('${F}', '${ADMIN}', 'admin'), ('${F}', '${MEMBER}', 'member');
        insert into fund_vehicles (id, fund_id, name) values ('${V1}', '${F}', 'Fund I'), ('${V2}', '${F}', 'Fund II'),
          ('${VX}', '${OTHER_F}', 'Elsewhere');`)

  for (const m of MIGRATIONS) applyFile(join('supabase/migrations', m))

  // ---- Backfill: nobody loses access on deploy. ----
  check('backfill grants an existing member every vehicle in their fund',
    psql(`select string_agg(vehicle_id::text, ',' order by vehicle_id::text) from fund_member_vehicles where user_id = '${MEMBER}'`),
    `${V1},${V2}`)

  // ---- access_context: the gate's one round trip. ----
  check('a member\'s access_context lists their granted vehicles',
    psql(`select ${sortedIds(`array(select jsonb_array_elements_text(access_context('${MEMBER}')->'vehicles')::uuid)`)}`),
    `${V1},${V2}`)

  psql(`delete from fund_member_vehicles where user_id = '${MEMBER}' and vehicle_id = '${V2}'`)
  check('narrowing a member\'s grants narrows access_context',
    psql(`select ${sortedIds(`array(select jsonb_array_elements_text(access_context('${MEMBER}')->'vehicles')::uuid)`)}`),
    V1)
  check('an admin sees every vehicle in the fund without grants, and none elsewhere',
    psql(`select ${sortedIds(`array(select jsonb_array_elements_text(access_context('${ADMIN}')->'vehicles')::uuid)`)}`),
    `${V1},${V2}`)

  psql(`insert into fund_members values ('${F}', '${LATE}', 'member')`)
  check('a member added after the backfill sees no vehicles until granted',
    psql(`select jsonb_array_length(access_context('${LATE}')->'vehicles')`),
    '0')

  // ---- vehicle_ids_readable(): the RLS mirror, as the signed-in caller. ----
  check('vehicle_ids_readable() returns the caller\'s own visible vehicles',
    psql(`select ${sortedIds('public.vehicle_ids_readable()')}`, { as: MEMBER }), V1)
  check('vehicle_ids_readable() gives an admin every fund vehicle',
    psql(`select ${sortedIds('public.vehicle_ids_readable()')}`, { as: ADMIN }), `${V1},${V2}`)

  let anonRefused = false
  try { psql(`set role anon; select public.vehicle_ids_readable()`) } catch { anonRefused = true }
  check('anon cannot execute vehicle_ids_readable()', String(anonRefused), 'true')

  // ---- company_vehicles: the one link between a company and its entities. ----
  const C = '00000000-0000-0000-0000-0000000000c0', D = '00000000-0000-0000-0000-0000000000d0'
  const E = '00000000-0000-0000-0000-0000000000e0', W = '00000000-0000-0000-0000-0000000000a0'
  const links = co => psql(`select coalesce(string_agg(v.name || ':' || cv.relation, ',' order by v.name), '')
    from company_vehicles cv join fund_vehicles v on v.id = cv.vehicle_id where cv.company_id = '${co}'`)
  const groups = co => psql(`select coalesce(array_to_string(portfolio_group, ','), '') from companies where id = '${co}'`)

  psql(`insert into companies (id, fund_id, name) values ('${C}', '${F}', 'Acme'), ('${D}', '${F}', 'Beta'),
          ('${E}', '${F}', 'Gamma'), ('${W}', '${F}', 'Token')`)
  psql(`insert into investment_transactions (fund_id, company_id, portfolio_group, transaction_type) values ('${F}', '${C}', 'Fund I', 'investment')`)
  check('a transaction tagged to an entity makes the company a holding of it', links(C), 'Fund I:holding')
  check('the derived portfolio_group follows', groups(C), 'Fund I')

  psql(`insert into investment_transactions (fund_id, company_id, portfolio_group, transaction_type) values ('${F}', '${C}', null, 'round_info')`)
  check('a company-wide price signal (no entity) adds nothing', links(C), 'Fund I:holding')

  psql(`update fund_vehicles set aliases = '{"Fund 2"}' where id = '${V2}'`)
  psql(`insert into chart_of_accounts (fund_id, vehicle_id, company_id, code) values ('${F}', '${V2}', '${C}', '1100-acme')`)
  check('a per-company ledger account makes it a holding of that entity too', links(C), 'Fund I:holding,Fund II:holding')

  psql(`insert into fund_holding_terms (company_id, fund_id, vehicle_id) values ('${D}', '${F}', '${V1}')`)
  check('fund holding terms make a fund holding a holding of its entity', links(D), 'Fund I:holding')

  psql(`insert into crypto_wallets (fund_id, company_id, portfolio_group, address) values ('${F}', '${W}', 'Fund 2', '0xabc')`)
  check('a wallet makes a token a holding of its entity, by alias', links(W), 'Fund II:holding')

  psql(`update companies set portfolio_group = '{"Fund II"}' where id = '${E}'`)
  check('naming an entity on an un-held company assigns it', links(E), 'Fund II:assigned')
  psql(`insert into investment_transactions (fund_id, company_id, portfolio_group, transaction_type) values ('${F}', '${E}', 'Fund II', 'investment')`)
  check('investing upgrades the assignment to a holding', links(E), 'Fund II:holding')

  psql(`delete from investment_transactions where company_id = '${C}' and portfolio_group = 'Fund I'`)
  check('removing the only Fund I transaction leaves the company assigned to Fund I, held by Fund II',
    links(C), 'Fund I:assigned,Fund II:holding')

  psql(`update companies set portfolio_group = '{"Old Fund","Fund I"}' where id = '${D}'`)
  check('a legacy entity name with no registry row is kept on the company, not dropped', groups(D), 'Fund I,Old Fund')
  check('…and adds no link, since it names no entity', links(D), 'Fund I:holding')

  // RLS: a member sees links only for their entities.
  check('a member granted Fund I sees only Fund I links',
    psql(`select count(*) from company_vehicles where vehicle_id <> '${V1}'`, { as: MEMBER }), '0')

  check('a deal can carry an owning entity',
    psql(`select count(*) from information_schema.columns where table_name = 'inbound_deals' and column_name = 'vehicle_id'`), '1')

  // ---- Re-runnable. ----
  for (const m of MIGRATIONS.slice(1)) applyFile(join('supabase/migrations', m))
  check('re-running the migration does not re-grant what was narrowed',
    psql(`select count(*) from fund_member_vehicles where user_id = '${MEMBER}'`), '1')
} catch (e) {
  failures++
  console.error(String(e.stderr ?? e.message ?? e))
} finally {
  if (started) { try { run('pg_ctl', ['-D', DATA, '-m', 'immediate', '-w', 'stop']) } catch {} }
  rmSync(WORK, { recursive: true, force: true })
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nentity access checks passed')
