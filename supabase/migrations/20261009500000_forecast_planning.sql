-- Budgets and rolling forecasts (plans/plan-budget-forecast.md).
--
-- A plan's inputs are account rules and month overrides; its OUTPUT is balanced, dated entries
-- shaped like the ledger — so P&L and cash timing are expressed by double entry (accruals,
-- prepayments) and a projected balance sheet stays possible later. Those entries live here and
-- only here: nothing in this migration touches journal_entries or journal_postings, and none of
-- these tables carries a `book`.
--
-- Access: every reader is a gated route, MCP tool or Analyst action holding the service-role key
-- (feature `budgeting` under the `accounting` domain, plus `management_company` for a manco
-- vehicle). So the Data API gets nothing — service_role only, RLS on, no authenticated policies —
-- per CLAUDE.md's rule for tables whose only reader is a gated route.

-- ---------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------

create table public.forecast_plans (
  id                       uuid primary key default gen_random_uuid(),
  fund_id                  uuid not null references public.funds(id) on delete cascade,
  vehicle_id               uuid not null references public.fund_vehicles(id) on delete cascade,
  kind                     text not null check (kind in ('budget', 'rolling_forecast')),
  name                     text not null check (length(btrim(name)) between 1 and 200),
  scenario                 text,
  fiscal_year              integer check (fiscal_year between 1900 and 2200),
  -- First-of-month dates. A budget is Jan..Dec of fiscal_year; a rolling forecast runs to end_month.
  start_month              date not null check (extract(day from start_month) = 1),
  end_month                date not null check (extract(day from end_month) = 1),
  horizon_months           integer check (horizon_months between 1 and 120),
  -- Null = the last closed month end, resolved every time the plan compiles.
  actuals_cutoff           date,
  seed                     jsonb not null default '{}'::jsonb,
  -- Payables/receivables open in the actuals when the plan starts settle this many months in
  -- (1 = the first plan month); 0 leaves them on the balance sheet.
  opening_settlement_months integer not null default 1 check (opening_settlement_months between 0 and 24),
  -- A fund/SPV plan can carry construction's investment, exit, call and distribution flows.
  include_construction     boolean not null default false,
  status                   text not null default 'active' check (status in ('active', 'archived')),
  -- Optimistic concurrency: every save names the revision it was made against.
  revision                 integer not null default 0,
  compiled_at              timestamptz,
  compiled_cutoff          date,
  compiled_closed_through  date,
  created_by               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (end_month >= start_month),
  check (kind <> 'budget' or fiscal_year is not null)
);

create table public.forecast_rules (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references public.forecast_plans(id) on delete cascade,
  fund_id      uuid not null references public.funds(id) on delete cascade,
  vehicle_id   uuid not null references public.fund_vehicles(id) on delete cascade,
  account_id   uuid not null references public.chart_of_accounts(id) on delete cascade,
  method       text not null check (method in ('manual', 'fixed', 'recurring', 'run_rate', 'growth', 'linked_fee', 'linked_construction')),
  params       jsonb not null default '{}'::jsonb,
  cash_timing  jsonb not null default '{"mode":"same"}'::jsonb,
  source       text not null default 'user' check (source in ('user', 'suggested', 'seeded')),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (plan_id, account_id)
);

create table public.forecast_overrides (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references public.forecast_plans(id) on delete cascade,
  fund_id     uuid not null references public.funds(id) on delete cascade,
  vehicle_id  uuid not null references public.fund_vehicles(id) on delete cascade,
  account_id  uuid not null references public.chart_of_accounts(id) on delete cascade,
  month       date not null check (extract(day from month) = 1),
  amount      numeric(20, 2) not null,
  note        text,
  created_at  timestamptz not null default now(),
  unique (plan_id, account_id, month)
);

-- Immutable once inserted: a published forecast is what was known at the time, and an approved
-- budget is the baseline variance is measured against. Revisions are new rows.
create table public.forecast_versions (
  id               uuid primary key default gen_random_uuid(),
  plan_id          uuid not null references public.forecast_plans(id) on delete cascade,
  fund_id          uuid not null references public.funds(id) on delete cascade,
  vehicle_id       uuid not null references public.fund_vehicles(id) on delete cascade,
  version_no       integer not null,
  label            text,
  notes            text,
  status           text not null check (status in ('published', 'approved')),
  actuals_cutoff   date,
  closed_through   date,
  start_month      date not null,
  end_month        date not null,
  -- The rules and overrides the entries were compiled from, verbatim.
  inputs           jsonb not null,
  published_by     uuid,
  published_at     timestamptz not null default now(),
  unique (plan_id, version_no)
);
create unique index forecast_versions_one_approved
  on public.forecast_versions (plan_id) where status = 'approved';

-- version_id null = the plan's current draft, rebuilt on every save.
create table public.forecast_entries (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references public.forecast_plans(id) on delete cascade,
  version_id   uuid references public.forecast_versions(id) on delete cascade,
  fund_id      uuid not null references public.funds(id) on delete cascade,
  vehicle_id   uuid not null references public.fund_vehicles(id) on delete cascade,
  entry_date   date not null,
  kind         text not null check (kind in ('recognition', 'settlement', 'prepayment', 'release',
                                           'investment', 'proceeds', 'capital_call', 'distribution')),
  memo         text,
  -- The P&L account the entry exists for, and what produced it. Not foreign keys: a published
  -- version outlives the rule that made it, and its `inputs` keep the rule's text.
  account_id   uuid not null,
  rule_id      uuid,
  override_id  uuid,
  source       text not null check (source in ('rule', 'override', 'opening', 'construction'))
);

create table public.forecast_postings (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references public.forecast_entries(id) on delete cascade,
  fund_id     uuid not null references public.funds(id) on delete cascade,
  account_id  uuid not null references public.chart_of_accounts(id) on delete cascade,
  amount      numeric(20, 2) not null,
  currency    text not null default 'USD'
);

-- Which funds pay which management company, and on what billing cycle. The fee AMOUNT is never
-- stored here: it is the fund's construction fee schedule (fund_construction_models), read by both
-- the manco's revenue forecast and the fund's expense forecast so the two cannot disagree. Nothing
-- in the app infers this link — a forecast that needs one and finds none says so.
create table public.manco_fee_links (
  id                uuid primary key default gen_random_uuid(),
  fund_id           uuid not null references public.funds(id) on delete cascade,
  manco_vehicle_id  uuid not null references public.fund_vehicles(id) on delete cascade,
  fund_vehicle_id   uuid not null references public.fund_vehicles(id) on delete cascade,
  every_months      integer not null default 3 check (every_months in (1, 3, 6, 12)),
  anchor_month      integer not null default 1 check (anchor_month between 1 and 12),
  direction         text not null default 'advance' check (direction in ('advance', 'arrears')),
  cash_lag_months   integer not null default 0 check (cash_lag_months between 0 and 12),
  active            boolean not null default true,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (manco_vehicle_id, fund_vehicle_id),
  check (manco_vehicle_id <> fund_vehicle_id)
);

create index manco_fee_links_manco_idx on public.manco_fee_links (fund_id, manco_vehicle_id);
create index manco_fee_links_fund_idx on public.manco_fee_links (fund_id, fund_vehicle_id);

create index forecast_plans_vehicle_idx on public.forecast_plans (fund_id, vehicle_id, status);
create index forecast_rules_plan_idx on public.forecast_rules (plan_id);
create index forecast_overrides_plan_idx on public.forecast_overrides (plan_id, account_id, month);
create index forecast_versions_plan_idx on public.forecast_versions (plan_id, version_no desc);
create index forecast_entries_plan_idx on public.forecast_entries (plan_id, version_id, entry_date);
create index forecast_postings_entry_idx on public.forecast_postings (entry_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Grants and RLS — service role only
-- ---------------------------------------------------------------------------------------------

alter table public.forecast_plans enable row level security;
alter table public.forecast_rules enable row level security;
alter table public.forecast_overrides enable row level security;
alter table public.forecast_versions enable row level security;
alter table public.forecast_entries enable row level security;
alter table public.forecast_postings enable row level security;
alter table public.manco_fee_links enable row level security;

revoke all on public.forecast_plans from anon, authenticated;
revoke all on public.forecast_rules from anon, authenticated;
revoke all on public.forecast_overrides from anon, authenticated;
revoke all on public.forecast_versions from anon, authenticated;
revoke all on public.forecast_entries from anon, authenticated;
revoke all on public.forecast_postings from anon, authenticated;
revoke all on public.manco_fee_links from anon, authenticated;

grant select, insert, update, delete on public.forecast_plans to service_role;
grant select, insert, update, delete on public.forecast_rules to service_role;
grant select, insert, update, delete on public.forecast_overrides to service_role;
grant select, insert, update, delete on public.forecast_versions to service_role;
grant select, insert, update, delete on public.forecast_entries to service_role;
grant select, insert, update, delete on public.forecast_postings to service_role;
grant select, insert, update, delete on public.manco_fee_links to service_role;

create policy "forecast_plans service role" on public.forecast_plans for all to service_role using (true) with check (true);
create policy "forecast_rules service role" on public.forecast_rules for all to service_role using (true) with check (true);
create policy "forecast_overrides service role" on public.forecast_overrides for all to service_role using (true) with check (true);
create policy "forecast_versions service role" on public.forecast_versions for all to service_role using (true) with check (true);
create policy "forecast_entries service role" on public.forecast_entries for all to service_role using (true) with check (true);
create policy "forecast_postings service role" on public.forecast_postings for all to service_role using (true) with check (true);
create policy "manco_fee_links service role" on public.manco_fee_links for all to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------------------------
-- 3. Every forecast entry balances — the same invariant as journal_postings_must_balance, with
--    its own function so neither table's trigger can be changed by editing the other's.
-- ---------------------------------------------------------------------------------------------

create or replace function public.assert_forecast_entry_balanced()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_entry    uuid;
  v_currency text;
  v_total    numeric;
begin
  v_entry := coalesce(new.entry_id, old.entry_id);
  if v_entry is null then
    return null;
  end if;

  select p.currency, sum(p.amount)
    into v_currency, v_total
  from public.forecast_postings p
  where p.entry_id = v_entry
  group by p.currency
  having round(sum(p.amount)::numeric, 2) <> 0
  limit 1;

  if found then
    raise exception
      'Forecast entry % is out of balance: its % postings sum to % (must be 0).',
      v_entry, v_currency, v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create constraint trigger forecast_postings_must_balance
  after insert or update or delete on public.forecast_postings
  deferrable initially deferred
  for each row execute function public.assert_forecast_entry_balanced();

-- A published version's entries never change.
create or replace function public.forbid_published_forecast_edit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Forecast versions are immutable' using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

create trigger forecast_versions_immutable
  before update on public.forecast_versions
  for each row execute function public.forbid_published_forecast_edit();

-- ---------------------------------------------------------------------------------------------
-- 4. Writes — one transaction each, guarded by the plan's revision
-- ---------------------------------------------------------------------------------------------
--
-- The service computes everything (validation, rule evaluation, compilation) in TypeScript and
-- hands the result over whole. These functions only make it atomic: lock the plan, compare the
-- revision the caller saw, apply. A stale revision raises PT409, which the service turns into 409.

create or replace function public.forecast_save(
  p_plan_id            uuid,
  p_fund_id            uuid,
  p_expected_revision  integer,
  p_plan_patch         jsonb,
  p_rule_upserts       jsonb,
  p_rule_deletes       uuid[],
  p_override_upserts   jsonb,
  p_override_deletes   uuid[],
  p_entries            jsonb,
  p_compiled           jsonb
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_plan public.forecast_plans%rowtype;
  v_entry jsonb;
  v_entry_id uuid;
begin
  select * into v_plan from public.forecast_plans
   where id = p_plan_id and fund_id = p_fund_id
   for update;
  if not found then
    raise exception 'Plan not found' using errcode = 'PT404';
  end if;
  if v_plan.revision <> p_expected_revision then
    raise exception 'The plan changed since you loaded it (revision % is now %). Reload and try again.',
      p_expected_revision, v_plan.revision using errcode = 'PT409';
  end if;

  if p_plan_patch is not null and p_plan_patch <> '{}'::jsonb then
    update public.forecast_plans set
      name           = case when p_plan_patch ? 'name' then p_plan_patch ->> 'name' else name end,
      scenario       = case when p_plan_patch ? 'scenario' then p_plan_patch ->> 'scenario' else scenario end,
      start_month    = case when p_plan_patch ? 'start_month' then (p_plan_patch ->> 'start_month')::date else start_month end,
      end_month      = case when p_plan_patch ? 'end_month' then (p_plan_patch ->> 'end_month')::date else end_month end,
      horizon_months = case when p_plan_patch ? 'horizon_months' then (p_plan_patch ->> 'horizon_months')::integer else horizon_months end,
      actuals_cutoff = case when p_plan_patch ? 'actuals_cutoff' then (p_plan_patch ->> 'actuals_cutoff')::date else actuals_cutoff end,
      status         = case when p_plan_patch ? 'status' then p_plan_patch ->> 'status' else status end,
      include_construction = case when p_plan_patch ? 'include_construction'
                                  then (p_plan_patch ->> 'include_construction')::boolean
                                  else include_construction end,
      opening_settlement_months = case when p_plan_patch ? 'opening_settlement_months'
                                       then (p_plan_patch ->> 'opening_settlement_months')::integer
                                       else opening_settlement_months end
    where id = p_plan_id;
  end if;

  if p_rule_deletes is not null and array_length(p_rule_deletes, 1) > 0 then
    delete from public.forecast_rules where plan_id = p_plan_id and id = any(p_rule_deletes);
  end if;
  if p_rule_upserts is not null and jsonb_array_length(p_rule_upserts) > 0 then
    insert into public.forecast_rules (id, plan_id, fund_id, vehicle_id, account_id, method, params, cash_timing, source, note)
    select r.id, p_plan_id, p_fund_id, v_plan.vehicle_id, r.account_id, r.method, r.params,
           coalesce(r.cash_timing, '{"mode":"same"}'::jsonb), coalesce(r.source, 'user'), r.note
      from jsonb_to_recordset(p_rule_upserts)
        as r(id uuid, account_id uuid, method text, params jsonb, cash_timing jsonb, source text, note text)
    on conflict (plan_id, account_id) do update set
      method = excluded.method, params = excluded.params, cash_timing = excluded.cash_timing,
      source = excluded.source, note = excluded.note, updated_at = now();
  end if;

  if p_override_deletes is not null and array_length(p_override_deletes, 1) > 0 then
    delete from public.forecast_overrides where plan_id = p_plan_id and id = any(p_override_deletes);
  end if;
  if p_override_upserts is not null and jsonb_array_length(p_override_upserts) > 0 then
    insert into public.forecast_overrides (id, plan_id, fund_id, vehicle_id, account_id, month, amount, note)
    select o.id, p_plan_id, p_fund_id, v_plan.vehicle_id, o.account_id, o.month, o.amount, o.note
      from jsonb_to_recordset(p_override_upserts)
        as o(id uuid, account_id uuid, month date, amount numeric, note text)
    on conflict (plan_id, account_id, month) do update set amount = excluded.amount, note = excluded.note;
  end if;

  -- The draft is rebuilt whole: it is a function of the inputs, never edited in place.
  delete from public.forecast_entries where plan_id = p_plan_id and version_id is null;
  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    insert into public.forecast_entries (plan_id, version_id, fund_id, vehicle_id, entry_date, kind, memo, account_id, rule_id, override_id, source)
    values (p_plan_id, null, p_fund_id, v_plan.vehicle_id, (v_entry ->> 'entry_date')::date, v_entry ->> 'kind',
            v_entry ->> 'memo', (v_entry ->> 'account_id')::uuid, (v_entry ->> 'rule_id')::uuid,
            (v_entry ->> 'override_id')::uuid, v_entry ->> 'source')
    returning id into v_entry_id;
    insert into public.forecast_postings (entry_id, fund_id, account_id, amount, currency)
    select v_entry_id, p_fund_id, p.account_id, p.amount, p.currency
      from jsonb_to_recordset(v_entry -> 'postings') as p(account_id uuid, amount numeric, currency text);
  end loop;

  update public.forecast_plans set
    revision = revision + 1,
    compiled_at = now(),
    compiled_cutoff = (p_compiled ->> 'cutoff')::date,
    compiled_closed_through = (p_compiled ->> 'closed_through')::date,
    updated_at = now()
  where id = p_plan_id;

  return v_plan.revision + 1;
end;
$$;

revoke all on function public.forecast_save(uuid, uuid, integer, jsonb, jsonb, uuid[], jsonb, uuid[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.forecast_save(uuid, uuid, integer, jsonb, jsonb, uuid[], jsonb, uuid[], jsonb, jsonb) to service_role;

create or replace function public.forecast_publish(
  p_plan_id            uuid,
  p_fund_id            uuid,
  p_expected_revision  integer,
  p_status             text,
  p_label              text,
  p_notes              text,
  p_user_id            uuid,
  p_meta               jsonb,
  p_inputs             jsonb,
  p_entries            jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_plan public.forecast_plans%rowtype;
  v_version_id uuid;
  v_version_no integer;
  v_entry jsonb;
  v_entry_id uuid;
begin
  select * into v_plan from public.forecast_plans
   where id = p_plan_id and fund_id = p_fund_id
   for update;
  if not found then
    raise exception 'Plan not found' using errcode = 'PT404';
  end if;
  if v_plan.revision <> p_expected_revision then
    raise exception 'The plan changed since you loaded it (revision % is now %). Reload and try again.',
      p_expected_revision, v_plan.revision using errcode = 'PT409';
  end if;
  if p_status = 'approved' and exists (
    select 1 from public.forecast_versions where plan_id = p_plan_id and status = 'approved'
  ) then
    raise exception 'This plan already has an approved baseline. Publish a revision instead.' using errcode = 'PT409';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_version_no from public.forecast_versions where plan_id = p_plan_id;

  insert into public.forecast_versions (plan_id, fund_id, vehicle_id, version_no, label, notes, status,
                                        actuals_cutoff, closed_through, start_month, end_month, inputs, published_by)
  values (p_plan_id, p_fund_id, v_plan.vehicle_id, v_version_no, p_label, p_notes, p_status,
          (p_meta ->> 'cutoff')::date, (p_meta ->> 'closed_through')::date,
          v_plan.start_month, v_plan.end_month, p_inputs, p_user_id)
  returning id into v_version_id;

  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    insert into public.forecast_entries (plan_id, version_id, fund_id, vehicle_id, entry_date, kind, memo, account_id, rule_id, override_id, source)
    values (p_plan_id, v_version_id, p_fund_id, v_plan.vehicle_id, (v_entry ->> 'entry_date')::date, v_entry ->> 'kind',
            v_entry ->> 'memo', (v_entry ->> 'account_id')::uuid, (v_entry ->> 'rule_id')::uuid,
            (v_entry ->> 'override_id')::uuid, v_entry ->> 'source')
    returning id into v_entry_id;
    insert into public.forecast_postings (entry_id, fund_id, account_id, amount, currency)
    select v_entry_id, p_fund_id, p.account_id, p.amount, p.currency
      from jsonb_to_recordset(v_entry -> 'postings') as p(account_id uuid, amount numeric, currency text);
  end loop;

  return jsonb_build_object('id', v_version_id, 'versionNo', v_version_no);
end;
$$;

revoke all on function public.forecast_publish(uuid, uuid, integer, text, text, text, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.forecast_publish(uuid, uuid, integer, text, text, text, uuid, jsonb, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. feature_default() learns `budgeting` — restated in full (rls-domain-policies.test.ts reads
--    the last definition and compares it with DEFAULT_FEATURE_VISIBILITY).
-- ---------------------------------------------------------------------------------------------

create or replace function public.feature_default(p_feature text)
returns text
language sql
immutable
parallel safe
as $$
  select case p_feature
    when 'interactions'       then 'off'
    when 'investments'        then 'everyone'
    when 'notes'              then 'off'
    when 'lp_letters'         then 'off'
    when 'imports'            then 'everyone'
    when 'asks'               then 'admin'
    when 'lps'                then 'off'
    when 'lp_tracking'        then 'off'
    when 'lp_portal'          then 'off'
    when 'lp_activity'        then 'off'
    when 'compliance'         then 'off'
    when 'deals'              then 'off'
    when 'diligence'          then 'off'
    when 'accounting'         then 'off'
    when 'gp_economics'       then 'off'
    when 'tax_reporting'      then 'off'
    when 'management_company' then 'off'
    when 'budgeting'          then 'off'
    -- An unknown key is not a reason to open a door.
    else 'off'
  end;
$$;
