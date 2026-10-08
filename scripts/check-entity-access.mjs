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
  '20261007100500_entity_storage.sql',
  '20261007100600_notes_entity.sql',
  '20261007100700_entity_documents.sql',
  '20261008030109_notes_entity_required.sql',
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
create table company_notes (id uuid primary key default gen_random_uuid(), fund_id uuid not null, company_id uuid, content text, mentioned_groups text[] default '{}', created_at timestamptz not null default now(), user_id uuid default '00000000-0000-0000-0000-0000000000a1');
create table interactions (id uuid primary key default gen_random_uuid(), fund_id uuid not null, company_id uuid, subject text);
create table lp_investors (id uuid primary key default gen_random_uuid(), fund_id uuid not null, name text);
create table lp_entities (id uuid primary key default gen_random_uuid(), fund_id uuid not null, investor_id uuid, entity_name text);
create table lp_investments (id uuid primary key default gen_random_uuid(), fund_id uuid not null, entity_id uuid, portfolio_group text not null);
create table commitment_events (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table lp_positions (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table lp_capital_events (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table capital_call_lines (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table distribution_lines (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table vehicle_closings (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, name text);
create table vehicle_closing_members (id uuid primary key default gen_random_uuid(), fund_id uuid not null, closing_id uuid, lp_entity_id uuid);
create table partner_allocation_terms (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table vehicle_partner_ownership (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table carry_payments (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, lp_entity_id uuid);
create table lp_letters (id uuid primary key default gen_random_uuid(), fund_id uuid not null, portfolio_group text not null, title text);
create table lp_documents (id uuid primary key default gen_random_uuid(), fund_id uuid not null, scope text not null, title text, vehicle text);
create table lp_document_shares (id uuid primary key default gen_random_uuid(), fund_id uuid not null, document_id uuid, lp_investor_id uuid);
create table lp_letter_shares (id uuid primary key default gen_random_uuid(), fund_id uuid not null, letter_id uuid, lp_investor_id uuid);
create table lp_access_events (id uuid primary key default gen_random_uuid(), fund_id uuid not null, lp_investor_id uuid, target_type text, target_id uuid, target_title text);
create table lp_deliveries (id uuid primary key default gen_random_uuid(), fund_id uuid not null, kind text, item_id uuid, lp_investor_id uuid, lp_entity_id uuid);
create table lp_onboarding_items (id uuid primary key default gen_random_uuid(), fund_id uuid not null, lp_entity_id uuid);
create table diligence_deals (id uuid primary key default gen_random_uuid(), fund_id uuid not null, name text, promoted_company_id uuid);
create table diligence_notes (id uuid primary key default gen_random_uuid(), fund_id uuid not null, deal_id uuid, body text);
alter table inbound_deals add column promoted_diligence_id uuid;
-- Supabase Storage, reduced to what the policies read.
create schema storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null);
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to authenticated;
grant select on storage.objects to authenticated;
alter table storage.objects enable row level security;
create policy "members" on storage.objects for select to authenticated using (true);
create table inbound_emails (id uuid primary key default gen_random_uuid(), fund_id uuid not null, company_id uuid);
create table note_reads (user_id uuid, note_id uuid);
create table compliance_deadlines (id uuid primary key default gen_random_uuid(), fund_id uuid not null, portfolio_group text not null default '', title text);
create table compliance_entry_data (id uuid primary key default gen_random_uuid(), deadline_id uuid, field_value text);
alter table compliance_entry_data enable row level security;
create policy "members" on compliance_entry_data for select to authenticated using (true);
create table pending_actions (id uuid primary key default gen_random_uuid(), fund_id uuid not null, vehicle_id uuid, action_type text);
-- The LP portal's own identity: an LP account sees its investor's rows.
create table lp_account_links (user_id uuid, lp_investor_id uuid);
create function get_my_lp_investor_ids() returns uuid[] language sql stable security definer set search_path = public as
  $$ select coalesce(array_agg(lp_investor_id), '{}') from lp_account_links where user_id = auth.uid() $$;
grant execute on function get_my_lp_investor_ids() to authenticated;
grant select on all tables in schema public to authenticated;
-- The existing domain policies, reduced to "any member of the fund": the entity rule must narrow
-- them, so they have to exist and pass first.
do $$ declare t text; begin
  foreach t in array array['companies','investment_transactions','journal_entries','company_notes','interactions','fund_vehicles','inbound_deals','crypto_wallets','fund_holding_terms','chart_of_accounts',
    'lp_investors','lp_entities','lp_investments','commitment_events','lp_letters','lp_documents','lp_document_shares','lp_letter_shares','lp_access_events','lp_deliveries','vehicle_closings','vehicle_closing_members',
    'diligence_deals','diligence_notes','inbound_emails','pending_actions','compliance_deadlines'] loop
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
  const TAGGED = '00000000-0000-0000-0000-0000000000f3'
  psql(`insert into companies (id, fund_id, name, portfolio_group) values ('${TAGGED}', '${OTHER_F}', 'Tagged', '{"Old SPV"}')`)
  const DD1 = '00000000-0000-0000-0000-00000000dd01', DD2 = '00000000-0000-0000-0000-00000000dd02', DD3 = '00000000-0000-0000-0000-00000000dd03'
  psql(`insert into diligence_deals (id, fund_id, name) values ('${DD1}', '${F}', 'From a Fund I deal'), ('${DD2}', '${F}', 'By hand'),
          ('${DD3}', '${OTHER_F}', 'One-entity fund')`)

  // Notes written before entities: a general note in the two-entity fund (no single answer), one
  // that names its entity (@Fund I), and one in the one-entity fund.
  psql(`insert into company_notes (fund_id, company_id, content, mentioned_groups) values
          ('${F}', null, 'legacy general', '{}'), ('${F}', null, 'legacy about Fund I', '{"Fund I"}'),
          ('${OTHER_F}', null, 'legacy elsewhere', '{}')`)

  for (const m of MIGRATIONS) applyFile(join('supabase/migrations', m))

  // ---- Backfill: nobody loses access on deploy. ----
  check('backfill gives every existing member the explicit "All entities" grant',
    psql(`select string_agg(all_entities::text, ',' order by user_id) from fund_members where fund_id = '${F}'`), 'true,true,true')

  // ---- access_context: the gate's one round trip. ----
  check('a member\'s access_context lists their granted vehicles',
    psql(`select ${sortedIds(`array(select jsonb_array_elements_text(access_context('${MEMBER}')->'vehicles')::uuid)`)}`),
    `${V1},${V2}`)

  psql(`update fund_members set all_entities = false where user_id = '${MEMBER}';
        insert into fund_member_vehicles (fund_id, user_id, vehicle_id) values ('${F}', '${MEMBER}', '${V1}')`)
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

  // ---- "All entities" is explicit: an admin or a member holding it is unscoped; nobody else. ----
  check('admins and All-entities members are unscoped; others are not',
    [ADMIN, FULL, MEMBER, LATE].map(u => psql(`select access_context('${u}')->>'vehicles_all'`)).join(','), 'true,true,false,false')
  // Holding every entity's grant row is NOT the same as "All entities": a new entity would narrow it.
  psql(`insert into fund_member_vehicles (fund_id, user_id, vehicle_id) values ('${F}', '${LATE}', '${V1}'), ('${F}', '${LATE}', '${V2}')`)
  check('a member granted each entity one by one is still scoped',
    psql(`select access_context('${LATE}')->>'vehicles_all'`), 'false')
  psql(`delete from fund_member_vehicles where user_id = '${LATE}'`)
  const V3 = '00000000-0000-0000-0000-000000000103'
  psql(`insert into fund_vehicles (id, fund_id, name) values ('${V3}', '${F}', 'Fund III')`)
  check('creating an entity does not narrow an All-entities member, and it sees the new one',
    psql(`select (access_context('${FULL}')->>'vehicles_all') || ',' || jsonb_array_length(access_context('${FULL}')->'vehicles')`), 'true,3')
  psql(`delete from fund_vehicles where id = '${V3}'`)

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
  check('a legacy entity name with no registry row is kept on the company, not dropped', groups(D), 'Old Fund,Fund I')
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

  // Every note belongs to an entity.
  check('notes: the backfill attributes a note that names one entity, and any note in a one-entity fund',
    psql(`select string_agg(n.content || ':' || coalesce(v.name, 'none'), ',' order by n.content) from company_notes n left join fund_vehicles v on v.id = n.vehicle_id`),
    'legacy about Fund I:Fund I,legacy elsewhere:Elsewhere,legacy general:none')
  psql(`insert into company_notes (fund_id, company_id, vehicle_id, content) values
          ('${F}', null, '${V1}', 'fund i'), ('${F}', '${C}', '${V1}', 'fund i on acme'),
          ('${F}', '${C}', '${V2}', 'fund ii on acme'), ('${F}', '${E}', '${V1}', 'fund i on gamma')`)
  check('notes: a member reads their entity\'s notes — not another entity\'s on a shared company, not one about a company they cannot see, not an unattributed one',
    psql(`select string_agg(content, ',' order by content) from company_notes`, { as: MEMBER }), 'fund i,fund i on acme,legacy about Fund I')
  check('notes: an admin reads them all, unattributed included',
    psql(`select count(*) from company_notes where fund_id = '${F}'`, { as: ADMIN }), '6')
  check('notes: the unread badge counts only notes the user may read',
    psql(`select count_unread_notes('${MEMBER}')`) + ',' + psql(`select count_unread_notes('${LATE}')`), '3,0')
  let unattributed = 'accepted'
  try { psql(`insert into company_notes (fund_id, content) values ('${F}', 'no entity')`) } catch { unattributed = 'refused' }
  check('notes: a new note with no entity is refused', unattributed, 'refused')
  psql(`update company_notes set content = 'legacy general, edited' where content = 'legacy general'`)
  check('notes: an unattributed legacy note can still be edited',
    psql(`select count(*) from company_notes where content = 'legacy general, edited'`), '1')

  psql(`insert into interactions (fund_id, company_id, subject) values ('${F}', '${E}', 'gamma call'), ('${F}', '${C}', 'shared call')`)
  check('a member reads interactions about their companies, not about a company they cannot see',
    psql(`select string_agg(subject, ',' order by subject) from interactions`, { as: MEMBER }), 'shared call')

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
        insert into lp_documents (id, fund_id, scope, title, vehicle) values ('${I1.replace('a001','d003')}', '${F}', 'investor', 'Ann Fund II receipt', 'Fund II'),
          ('${I1.replace('a001','d004')}', '${F}', 'investor', 'Ann Fund I receipt', 'Fund I');
        insert into lp_document_shares (fund_id, document_id, lp_investor_id) values ('${F}', '${I1.replace('a001','d002')}', '${I2}'),
          ('${F}', '${I1.replace('a001','d003')}', '${I1}'), ('${F}', '${I1.replace('a001','d004')}', '${I1}');
        insert into lp_account_links values ('${LP_USER}', '${I2}');`)
  check('a member sees LPs with a position in their entity — by legacy group or by commitment',
    psql(`select string_agg(entity_name, ',' order by entity_name) from lp_entities`, { as: MEMBER }), 'Ann LLC,Cy LP')
  check('…and the investors behind them only',
    psql(`select string_agg(name, ',' order by name) from lp_investors`, { as: MEMBER }), 'Ann,Cy')
  check('a member sees only their entity\'s commitment rows',
    psql(`select count(*) from commitment_events`, { as: MEMBER }), '1')
  check('…their entity\'s letters',
    psql(`select string_agg(title, ',') from lp_letters`, { as: MEMBER }), 'Q3 Fund I')
  check('…fund-wide documents and their entity\'s documents for visible LPs — not another entity\'s, even for a shared LP',
    psql(`select string_agg(title, ',' order by title) from lp_documents`, { as: MEMBER }), 'Ann Fund I receipt,Everyone')
  // An LP admitted to a Fund I closing, before any commitment is recorded — visible to Fund I.
  const L4 = '00000000-0000-0000-0000-00000000b004', CL = '00000000-0000-0000-0000-00000000c10e'
  psql(`insert into lp_entities (id, fund_id, entity_name) values ('${L4}', '${F}', 'Dee Closing');
        insert into vehicle_closings (id, fund_id, vehicle_id, name) values ('${CL}', '${F}', '${V1}', 'First close');
        insert into vehicle_closing_members (fund_id, closing_id, lp_entity_id) values ('${F}', '${CL}', '${L4}')`)
  check('an LP admitted to one of the member\'s entities\' closings is visible before any commitment',
    psql(`select count(*) from lp_entities where id = '${L4}'`, { as: MEMBER }), '1')
  // Rows that belong to another entity's item stay hidden even when the LP is shared (Ann is in both).
  const LT1 = '00000000-0000-0000-0000-00000000e001', LT2 = '00000000-0000-0000-0000-00000000e002', CL2 = '00000000-0000-0000-0000-00000000c20e'
  const D3 = I1.replace('a001','d003'), D4 = I1.replace('a001','d004')
  psql(`insert into lp_letters (id, fund_id, portfolio_group, title) values ('${LT1}', '${F}', 'Fund I', 'Ann I'), ('${LT2}', '${F}', 'Fund II', 'Ann II');
        insert into lp_letter_shares (fund_id, letter_id, lp_investor_id) values ('${F}', '${LT1}', '${I1}'), ('${F}', '${LT2}', '${I1}');
        insert into vehicle_closings (id, fund_id, vehicle_id, name) values ('${CL2}', '${F}', '${V2}', 'Fund II close');
        insert into vehicle_closing_members (fund_id, closing_id, lp_entity_id) values ('${F}', '${CL2}', '${L1}');
        insert into lp_access_events (fund_id, lp_investor_id, target_type, target_id, target_title) values
          ('${F}', '${I1}', 'document', '${D3}', 'Ann Fund II receipt'), ('${F}', '${I1}', 'document', '${D4}', 'Ann Fund I receipt'),
          ('${F}', '${I1}', 'letter', '${LT2}', 'Ann II'), ('${F}', '${I1}', 'portal', null, 'Portal');
        insert into lp_deliveries (fund_id, kind, item_id, lp_investor_id) values
          ('${F}', 'letter', '${LT1}', '${I1}'), ('${F}', 'letter', '${LT2}', '${I1}'), ('${F}', 'document', '${D3}', '${I1}')`)
  check('document shares: only for documents the member can see, not a shared LP\'s other-entity document',
    psql(`select count(*) from lp_document_shares where lp_investor_id = '${I1}'`, { as: MEMBER }), '1')
  check('letter shares: only for their entity\'s letters',
    psql(`select count(*) from lp_letter_shares`, { as: MEMBER }), '1')
  check('closing members: only of their entity\'s closings, though the LP is visible',
    psql(`select string_agg(closing_id::text, ',') from vehicle_closing_members`, { as: MEMBER }), CL)
  check('LP activity: events about another entity\'s document or letter are hidden; the rest stay',
    psql(`select string_agg(target_title, ',' order by target_title) from lp_access_events`, { as: MEMBER }), 'Ann Fund I receipt,Portal')
  check('deliveries: only of their entity\'s letters and documents',
    psql(`select count(*) from lp_deliveries`, { as: MEMBER }), '1')
  check('an admin sees every share, member, event and delivery',
    psql(`select (select count(*) from lp_letter_shares) || ',' || (select count(*) from vehicle_closing_members) || ',' || (select count(*) from lp_access_events) || ',' || (select count(*) from lp_deliveries)`, { as: ADMIN }), '2,2,4,3')

  check('the service-side lookup returns the same LPs, distinct, for given entities and names',
    psql(`select string_agg(x::text, ',' order by x::text) from unnest(public.lp_entity_ids_for(array['${V1}']::uuid[], array['Fund I'])) x`),
    [L1, L3, L4].sort().join(','))
  check('an admin sees every LP',
    psql(`select count(*) from lp_entities`, { as: ADMIN }), '4')
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

  // ---- Storage: document files follow the same rule as their rows. ----
  const EM = '00000000-0000-0000-0000-00000000ee01'
  psql(`insert into inbound_emails (id, fund_id, company_id) values ('${EM}', '${F}', '${E}');
        insert into storage.objects (bucket_id, name) values
          ('company-documents', '${F}/${D}/beta.pdf'), ('company-documents', '${F}/${E}/gamma.pdf'),
          ('lp-documents', '${F}/receipt.pdf'), ('email-attachments', '${EM}/deck.pdf'), ('avatars', 'me.png')`)
  check('a member reads company documents only under companies their entities hold, and other buckets as before',
    psql(`select string_agg(name, ',' order by name) from storage.objects`, { as: MEMBER }),
    [`${F}/${D}/beta.pdf`, 'me.png'].sort().join(','))
  check('an unscoped caller reads every document file',
    psql(`select count(*) from storage.objects`, { as: ADMIN }), '5')

  // ---- Single-entity funds: unlinked companies are assigned to the one entity on push. ----
  check('a company in a one-entity fund is assigned to that entity, so no member loses it',
    psql(`select v.name || ':' || cv.relation from company_vehicles cv join fund_vehicles v on v.id = cv.vehicle_id where cv.company_id = '${ORPHAN}'`),
    'Elsewhere:assigned')
  check('assigning it keeps a legacy tag it already had',
    psql(`select array_to_string(portfolio_group, ',') from companies where id = '${TAGGED}'`), 'Old SPV,Elsewhere')
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

  // ---- Writes through the Data API cannot reach another entity. ----
  psql(`create policy "test writes" on investment_transactions for insert to authenticated with check (true);
        create policy "test writes" on companies for update to authenticated using (true) with check (true);
        grant insert on investment_transactions to authenticated; grant update on companies to authenticated`)
  const tryAs = (sql, as) => { try { psql(sql, { as }); return 'accepted' } catch { return 'refused' } }
  check('a member cannot write a row in their entity against a company they cannot see (it would link it to them)',
    tryAs(`insert into investment_transactions (fund_id, company_id, portfolio_group, transaction_type) values ('${F}', '${E}', 'Fund I', 'investment')`, MEMBER), 'refused')
  check('…but can for a company of theirs',
    tryAs(`insert into investment_transactions (fund_id, company_id, portfolio_group, transaction_type) values ('${F}', '${D}', 'Fund I', 'investment')`, MEMBER), 'accepted')
  check('a member cannot write a company-wide (entity-less) price row',
    tryAs(`insert into investment_transactions (fund_id, company_id, portfolio_group, transaction_type) values ('${F}', '${D}', null, 'round_info')`, MEMBER), 'refused')
  check('a member cannot drop another entity\'s tag from a shared company',
    tryAs(`update companies set portfolio_group = array['Fund I'] where id = '${C}'`, MEMBER), 'refused')
  check('an admin can',
    tryAs(`update companies set portfolio_group = portfolio_group where id = '${C}'`, ADMIN), 'accepted')

  // The diligence trigger runs with definer rights: it must stay inside the deal's fund.
  const DD4 = '00000000-0000-0000-0000-00000000dd04'
  psql(`insert into diligence_deals (id, fund_id, name) values ('${DD4}', '${OTHER_F}', 'Other tenant');
        insert into inbound_deals (fund_id, vehicle_id, promoted_diligence_id) values ('${F}', '${V1}', '${DD4}')`)
  check('promoting a deal cannot stamp an entity on another tenant\'s diligence record',
    psql(`select coalesce(vehicle_id::text, 'none') from diligence_deals where id = '${DD4}'`), 'none')

  // Staged AI/agent actions, and mail matched to no company.
  psql(`insert into pending_actions (fund_id, vehicle_id, action_type) values ('${F}', '${V1}', 'a'), ('${F}', '${V2}', 'b'), ('${F}', null, 'c');
        insert into inbound_emails (fund_id, company_id) values ('${F}', null)`)
  check('pending actions: a member sees only their entity\'s',
    psql(`select string_agg(action_type, ',') from pending_actions`, { as: MEMBER }), 'a')
  check('unmatched mail (no company) is for unscoped callers to triage',
    psql(`select count(*) from inbound_emails where company_id is null`, { as: MEMBER }) + ',' + psql(`select count(*) from inbound_emails where company_id is null`, { as: ADMIN }), '0,1')

  // Compliance: '' is the fund's own; an entity's rows are that entity's; entry data follows its deadline.
  psql(`insert into compliance_deadlines (id, fund_id, portfolio_group, title) values
          ('00000000-0000-0000-0000-00000000cd01', '${F}', '', 'Form D'), ('00000000-0000-0000-0000-00000000cd02', '${F}', 'Fund I', 'Fund I K-1s'),
          ('00000000-0000-0000-0000-00000000cd03', '${F}', 'Fund II', 'Fund II K-1s');
        insert into compliance_entry_data (deadline_id, field_value) values
          ('00000000-0000-0000-0000-00000000cd02', 'one'), ('00000000-0000-0000-0000-00000000cd03', 'two')`)
  check('compliance: a member sees fund-level and their entity\'s deadlines, and only their entry data',
    psql(`select string_agg(title, ',' order by title) from compliance_deadlines`, { as: MEMBER }) + '|' +
    psql(`select string_agg(field_value, ',') from compliance_entry_data`, { as: MEMBER }), 'Form D,Fund I K-1s|one')

  // ---- Names, tags, and who passes through. ----
  const Z = '00000000-0000-0000-0000-0000000000f9'
  psql(`insert into companies (id, fund_id, name, portfolio_group) values ('${Z}', '${F}', 'Zeta', '{"Fund 2","Fund I"}')`)
  check('a company\'s tags keep their order and spelling (an alias stays an alias)', groups(Z), 'Fund 2,Fund I')
  check('…and the alias still links its entity', links(Z), 'Fund I:assigned,Fund II:assigned')
  check('an entity cannot take another entity\'s name as an alias',
    tryAs(`update fund_vehicles set aliases = aliases || '{"Fund I"}' where id = '${V2}'`, ADMIN), 'refused')
  check('…nor be created under another entity\'s alias',
    tryAs(`insert into fund_vehicles (fund_id, name) values ('${F}', 'Fund 2')`, ADMIN), 'refused')

  const ELSE_MEMBER = '00000000-0000-0000-0000-0000000000e8', VIEWER = '00000000-0000-0000-0000-0000000000e7'
  psql(`insert into auth.users values ('${ELSE_MEMBER}'), ('${VIEWER}');
        insert into fund_members values ('${OTHER_F}', '${ELSE_MEMBER}', 'member'), ('${F}', '${VIEWER}', 'viewer');
        insert into lp_account_links values ('${ELSE_MEMBER}', '${I2}')`)
  check('a member of another fund who is an LP here still reads their own investor row',
    psql(`select string_agg(name, ',') from lp_investors where fund_id = '${F}'`, { as: ELSE_MEMBER }), 'Bob')
  check('the read-only demo viewer sees every entity',
    psql(`select access_context('${VIEWER}')->>'vehicles_all'`), 'true')

  // ---- Entity governing documents: service role only; search finds clause text. ----
  psql(`insert into entity_documents (id, fund_id, vehicle_id, kind, title, file_name, storage_path)
          values ('00000000-0000-0000-0000-0000000ed001', '${F}', '${V1}', 'lpa', 'Fund I LPA', 'lpa.pdf', 'x');
        insert into entity_document_chunks (fund_id, vehicle_id, document_id, ordinal, locator, text)
          values ('${F}', '${V1}', '00000000-0000-0000-0000-0000000ed001', 0, '{"page": 12}', 'The Management Fee shall equal two percent of Commitments during the Investment Period.')`)
  check('entity documents: the search finds a clause, with its page',
    psql(`select title || ':' || (locator->>'page') from entity_document_search('${F}', array['${V1}']::uuid[], 'management fee', 5)`), 'Fund I LPA:12')
  check('…and only in the entities passed',
    psql(`select count(*) from entity_document_search('${F}', array['${V2}']::uuid[], 'management fee', 5)`), '0')
  let docsDenied = 'readable'
  try { psql(`select count(*) from entity_documents`, { as: ADMIN }) } catch { docsDenied = 'denied' }
  check('entity documents are not readable through the Data API, even by an admin', docsDenied, 'denied')

  // ---- Re-runnable. ----
  for (const m of MIGRATIONS.slice(1)) applyFile(join('supabase/migrations', m))
  check('re-running the migration does not re-grant what was narrowed',
    psql(`select (select count(*) from fund_member_vehicles where user_id = '${MEMBER}') || ',' || (select all_entities from fund_members where user_id = '${MEMBER}')`), '1,false')
} catch (e) {
  failures++
  console.error(String(e.stderr ?? e.message ?? e))
} finally {
  if (started) { try { run('pg_ctl', ['-D', DATA, '-m', 'immediate', '-w', 'stop']) } catch {} }
  rmSync(WORK, { recursive: true, force: true })
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nentity access checks passed')
