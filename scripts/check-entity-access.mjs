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
  '20261007100200_entity_rls.sql',
  '20261007100300_entity_rls_lp.sql',
  '20261007100400_diligence_entity.sql',
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
create table journal_entries (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, memo text);
create table company_notes (id uuid primary key default gen_random_uuid(), fund_id uuid not null, company_id uuid, content text);
create table lp_investors (id uuid primary key default gen_random_uuid(), fund_id uuid not null, name text);
create table lp_entities (id uuid primary key default gen_random_uuid(), fund_id uuid not null, investor_id uuid, entity_name text);
create table lp_investments (id uuid primary key default gen_random_uuid(), fund_id uuid not null, entity_id uuid, portfolio_group text not null);
create table commitment_events (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table lp_positions (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table lp_capital_events (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table capital_call_lines (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table distribution_lines (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table lp_letters (id uuid primary key default gen_random_uuid(), fund_id uuid not null, portfolio_group text not null, title text);
create table lp_documents (id uuid primary key default gen_random_uuid(), fund_id uuid not null, scope text not null, title text);
create table lp_document_shares (id uuid primary key default gen_random_uuid(), fund_id uuid not null, document_id uuid, lp_investor_id uuid);
create table lp_onboarding_items (id uuid primary key default gen_random_uuid(), fund_id uuid not null, lp_entity_id uuid);
create table diligence_deals (id uuid primary key default gen_random_uuid(), fund_id uuid not null, name text, promoted_company_id uuid);
create table diligence_notes (id uuid primary key default gen_random_uuid(), fund_id uuid not null, deal_id uuid, body text);
alter table inbound_deals add column promoted_diligence_id uuid;
-- The LP portal's own identity: an LP account sees its investor's rows.
create table lp_account_links (user_id uuid, lp_investor_id uuid);
create function get_my_lp_investor_ids() returns uuid[] language sql stable security definer set search_path = public as
  $$ select coalesce(array_agg(lp_investor_id), '{}') from lp_account_links where user_id = auth.uid() $$;
grant execute on function get_my_lp_investor_ids() to authenticated;
grant select on all tables in schema public to authenticated;
-- The existing domain policies, reduced to "any member of the fund": the entity rule must narrow
-- them, so they have to exist and pass first.
do $$ declare t text; begin
  foreach t in array array['companies','investment_transactions','journal_entries','company_notes','fund_vehicles','inbound_deals','crypto_wallets','fund_holding_terms','chart_of_accounts',
    'lp_investors','lp_entities','lp_investments','commitment_events','lp_letters','lp_documents','lp_document_shares',
    'diligence_deals','diligence_notes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "members" on %I for select to authenticated using (fund_id in (select fund_id from fund_members where user_id = auth.uid()))', t);
  end loop;
end $$;
-- The LP portal's own policy on investors: an LP reads its own investor row (not a fund member).
create policy "lp self" on lp_investors for select to authenticated using (id = any(get_my_lp_investor_ids()));
alter table fund_members enable row level security;
create policy "self" on fund_members for select to authenticated using (true);
`

const F = '00000000-0000-0000-0000-00000000000f'
const OTHER_F = '00000000-0000-0000-0000-0000000000ff'
const ADMIN = '00000000-0000-0000-0000-0000000000a1'
const MEMBER = '00000000-0000-0000-0000-0000000000b1'
const LATE = '00000000-0000-0000-0000-0000000000c1'
const FULL = '00000000-0000-0000-0000-0000000000c2'
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
  psql(`insert into auth.users values ('${ADMIN}'), ('${MEMBER}'), ('${LATE}'), ('${FULL}');
        insert into funds values ('${F}'), ('${OTHER_F}');
        insert into fund_members values ('${F}', '${ADMIN}', 'admin'), ('${F}', '${MEMBER}', 'member'), ('${F}', '${FULL}', 'member');
        insert into fund_vehicles (id, fund_id, name) values ('${V1}', '${F}', 'Fund I'), ('${V2}', '${F}', 'Fund II'),
          ('${VX}', '${OTHER_F}', 'Elsewhere');`)

  // Before the migrations: a fund with ONE entity and a company never tagged to it, and a company
  // in the two-entity fund tagged to nothing. Pushing must not hide the first from members.
  const ORPHAN = '00000000-0000-0000-0000-0000000000f1', LOOSE = '00000000-0000-0000-0000-0000000000f2'
  psql(`insert into companies (id, fund_id, name) values ('${ORPHAN}', '${OTHER_F}', 'Orphan'), ('${LOOSE}', '${F}', 'Loose')`)
  const DD1 = '00000000-0000-0000-0000-00000000dd01', DD2 = '00000000-0000-0000-0000-00000000dd02', DD3 = '00000000-0000-0000-0000-00000000dd03'
  psql(`insert into diligence_deals (id, fund_id, name) values ('${DD1}', '${F}', 'From a Fund I deal'), ('${DD2}', '${F}', 'By hand'),
          ('${DD3}', '${OTHER_F}', 'One-entity fund')`)

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

  // ---- A member granted EVERY entity is unscoped, like an admin: nobody loses access on push. ----
  check('a member granted every entity is reported as seeing all of them',
    psql(`select access_context('${ADMIN}')->>'vehicles_all'`) + ',' + psql(`select access_context('${LATE}')->>'vehicles_all'`), 'true,false')

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

  // ---- RLS: the browser's Data API path sees only the caller's entities. ----
  const J1 = '00000000-0000-0000-0000-0000000001a1', J2 = '00000000-0000-0000-0000-0000000001a2', J0 = '00000000-0000-0000-0000-0000000001a0'
  psql(`insert into journal_entries (id, fund_id, vehicle_id, memo) values ('${J1}', '${F}', '${V1}', 'one'), ('${J2}', '${F}', '${V2}', 'two'),
          ('${J0}', '${F}', null, 'legacy')`)
  check('a member granted Fund I reads only Fund I\'s journal entries',
    psql(`select string_agg(memo, ',' order by memo) from journal_entries`, { as: MEMBER }), 'one')
  check('an admin reads every entity\'s, and legacy rows with no entity',
    psql(`select string_agg(memo, ',' order by memo) from journal_entries`, { as: ADMIN }), 'legacy,one,two')

  // Companies: Acme is held by Fund II (ledger) and assigned to Fund I; Beta held by Fund I; Gamma and
  // Token by Fund II only.
  check('a member sees companies linked to their entities only',
    psql(`select string_agg(name, ',' order by name) from companies`, { as: MEMBER }), 'Acme,Beta')
  // FULL is granted both entities: unscoped, so it also sees the unassigned company, as an admin does.
  check('a member granted every entity sees unassigned companies too',
    psql(`select count(*) from companies where fund_id = '${F}'`, { as: FULL }), '5')
  check('an admin sees every company',
    psql(`select count(*) from companies`, { as: ADMIN }), '5')

  psql(`insert into investment_transactions (fund_id, company_id, portfolio_group, transaction_type) values
          ('${F}', '${C}', 'Fund II', 'investment')`)
  check('a member reads a shared company\'s Fund I rows and its company-wide price signals, not Fund II\'s',
    psql(`select string_agg(coalesce(portfolio_group, 'company-wide'), ',' order by portfolio_group nulls first)
            from investment_transactions where company_id = '${C}'`, { as: MEMBER }), 'company-wide')
  check('…and none of a company only Fund II holds',
    psql(`select count(*) from investment_transactions where company_id = '${E}'`, { as: MEMBER }), '0')

  psql(`insert into company_notes (fund_id, company_id, content) values ('${F}', '${E}', 'gamma note'), ('${F}', null, 'general')`)
  check('a member reads fund-wide notes, not notes about a company they cannot see',
    psql(`select string_agg(content, ',' order by content) from company_notes`, { as: MEMBER }), 'general')

  check('a member sees only their entities in the entity list',
    psql(`select string_agg(name, ',' order by name) from fund_vehicles`, { as: MEMBER }), 'Fund I')

  // The entity helpers are evaluated once per query (an InitPlan), not once per row.
  const plan = execFileSync('psql', ['-h', WORK, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-qtA', '-c',
    `set role authenticated; select set_config('request.jwt.claim.sub', '${MEMBER}', false); explain select * from companies`],
    { stdio: 'pipe' }).toString()
  check('the companies policy evaluates its helpers once per query', String(/InitPlan/.test(plan)), 'true')

  // ---- LPs: visible when they have a position in one of the caller's entities. ----
  const I1 = '00000000-0000-0000-0000-00000000a001', I2 = '00000000-0000-0000-0000-00000000a002', I3 = '00000000-0000-0000-0000-00000000a003'
  const L1 = '00000000-0000-0000-0000-00000000b001', L2 = '00000000-0000-0000-0000-00000000b002', L3 = '00000000-0000-0000-0000-00000000b003'
  const LP_USER = '00000000-0000-0000-0000-0000000000e9'
  psql(`insert into auth.users values ('${LP_USER}');
        insert into lp_investors (id, fund_id, name) values ('${I1}', '${F}', 'Ann'), ('${I2}', '${F}', 'Bob'), ('${I3}', '${F}', 'Cy');
        insert into lp_entities (id, fund_id, investor_id, entity_name) values ('${L1}', '${F}', '${I1}', 'Ann LLC'), ('${L2}', '${F}', '${I2}', 'Bob Trust'), ('${L3}', '${F}', '${I3}', 'Cy LP');
        insert into lp_investments (fund_id, entity_id, portfolio_group) values ('${F}', '${L1}', 'Fund I'), ('${F}', '${L2}', 'Fund II');
        insert into commitment_events (fund_id, vehicle_id, lp_entity_id) values ('${F}', '${V1}', '${L3}'), ('${F}', '${V2}', '${L2}');
        insert into lp_letters (fund_id, portfolio_group, title) values ('${F}', 'Fund I', 'Q3 Fund I'), ('${F}', 'Fund II', 'Q3 Fund II');
        insert into lp_documents (id, fund_id, scope, title) values ('${I1.replace('a001','d001')}', '${F}', 'fund', 'Everyone'),
          ('${I1.replace('a001','d002')}', '${F}', 'investor', 'For Bob');
        insert into lp_document_shares (fund_id, document_id, lp_investor_id) values ('${F}', '${I1.replace('a001','d002')}', '${I2}');
        insert into lp_account_links values ('${LP_USER}', '${I2}');`)
  check('a member sees LPs with a position in their entity — by legacy group or by commitment',
    psql(`select string_agg(entity_name, ',' order by entity_name) from lp_entities`, { as: MEMBER }), 'Ann LLC,Cy LP')
  check('…and the investors behind them only',
    psql(`select string_agg(name, ',' order by name) from lp_investors`, { as: MEMBER }), 'Ann,Cy')
  check('a member sees only their entity\'s commitment rows',
    psql(`select count(*) from commitment_events`, { as: MEMBER }), '1')
  check('…their entity\'s letters',
    psql(`select string_agg(title, ',') from lp_letters`, { as: MEMBER }), 'Q3 Fund I')
  check('…fund-wide documents, not documents shared only with an investor they cannot see',
    psql(`select string_agg(title, ',') from lp_documents`, { as: MEMBER }), 'Everyone')
  check('an admin sees every LP',
    psql(`select count(*) from lp_entities`, { as: ADMIN }), '3')
  check('an LP portal user (not a fund member) still reads their own investor row',
    psql(`select string_agg(name, ',') from lp_investors`, { as: LP_USER }), 'Bob')

  // ---- Diligence carries its owning entity, backfilled from the deal it was promoted from. ----
  check('a diligence record in a one-entity fund is assigned that entity on push',
    psql(`select coalesce(v.name, 'none') from diligence_deals d left join fund_vehicles v on v.id = d.vehicle_id where d.id = '${DD3}'`), 'Elsewhere')
  psql(`insert into diligence_notes (fund_id, deal_id, body) values ('${F}', '${DD1}', 'note one'), ('${F}', '${DD2}', 'note two');
        update diligence_deals set vehicle_id = '${V1}' where id = '${DD1}'`)
  check('a member sees diligence for their entity only — not unassigned records',
    psql(`select string_agg(name, ',') from diligence_deals`, { as: MEMBER }), 'From a Fund I deal')
  check('…and only those records\' notes',
    psql(`select string_agg(body, ',') from diligence_notes`, { as: MEMBER }), 'note one')
  check('an admin sees all diligence',
    psql(`select count(*) from diligence_deals where fund_id = '${F}'`, { as: ADMIN }), '2')
  psql(`insert into inbound_deals (fund_id, vehicle_id, promoted_diligence_id) values ('${F}', '${V2}', '${DD2}')`)
  check('promoting a deal to diligence carries the deal\'s entity',
    psql(`select v.name from diligence_deals d join fund_vehicles v on v.id = d.vehicle_id where d.id = '${DD2}'`), 'Fund II')

  // ---- Single-entity funds: unlinked companies are assigned to the one entity on push. ----
  check('a company in a one-entity fund is assigned to that entity, so no member loses it',
    psql(`select v.name || ':' || cv.relation from company_vehicles cv join fund_vehicles v on v.id = cv.vehicle_id where cv.company_id = '${ORPHAN}'`),
    'Elsewhere:assigned')
  check('a company in a several-entity fund stays unassigned — there is no single right answer',
    psql(`select count(*) from company_vehicles where company_id = '${LOOSE}'`), '0')

  // ---- Renaming an entity keeps its companies linked. ----
  // The app retags portfolio_group strings to the new name FIRST, then renames the row keeping the
  // old name as an alias (lib/vehicles.ts). Between the two, the new name matches no entity.
  const before = links(C)  // Acme: assigned to Fund I by name only
  psql(`update investment_transactions set portfolio_group = 'Fund One' where portfolio_group = 'Fund I'`)
  psql(`update companies set portfolio_group = array_replace(portfolio_group, 'Fund I', 'Fund One')`)
  psql(`update fund_vehicles set name = 'Fund One', aliases = aliases || '{"Fund I"}' where id = '${V1}'`)
  check('renaming an entity relinks its companies under the new name', links(C), before.replace('Fund I:', 'Fund One:').split(',').sort().join(','))
  psql(`update fund_vehicles set name = 'Fund I', aliases = '{}' where id = '${V1}'`)
  psql(`update investment_transactions set portfolio_group = 'Fund I' where portfolio_group = 'Fund One'`)
  psql(`update companies set portfolio_group = array_replace(portfolio_group, 'Fund One', 'Fund I')`)

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
