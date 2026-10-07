-- company_vehicles: the one answer to "which entities is this company associated with?"
--
-- Entity access needs a single answer, and there were three: `companies.portfolio_group[]` (the
-- dashboard), each transaction's `portfolio_group` (the schedule of investments), and the entity's
-- per-company ledger accounts (the ledger-only schedule rows). This table is derived from all of
-- them and maintained by triggers, never hand-edited:
--
--   holding  — the entity holds it: a transaction tagged to the entity, a per-company account in the
--              entity's chart, fund holding terms naming the entity, or a wallet in the entity;
--   assigned — named on the company (portfolio_group) without a holding yet: a prospect, a pipeline
--              company, or one whose last transaction in that entity was removed.
--
-- `companies.portfolio_group` becomes DERIVED from this table, so every existing reader keeps
-- working. An edit to it (the company form still writes it) is read as an assignment.
--
-- A company with no row here is visible to admins only. See plans/spec-entity-access-and-portfolio.md.

create table if not exists public.company_vehicles (
  fund_id    uuid not null references funds(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  vehicle_id uuid not null references fund_vehicles(id) on delete cascade,
  relation   text not null check (relation in ('assigned', 'holding')),
  created_at timestamptz not null default now(),
  primary key (company_id, vehicle_id)
);

create index if not exists company_vehicles_vehicle_idx on public.company_vehicles (fund_id, vehicle_id);

-- Written only by the triggers below (security definer). Readable through the Data API, scoped to
-- the caller's entities.
grant select on public.company_vehicles to authenticated;
grant select, insert, update, delete on public.company_vehicles to service_role;

alter table public.company_vehicles enable row level security;

drop policy if exists "Members read links for their entities" on public.company_vehicles;
create policy "Members read links for their entities"
  on public.company_vehicles for select to authenticated
  using (vehicle_id = any((select public.vehicle_ids_readable())::uuid[]));

-- ---------------------------------------------------------------------------
-- The entity a portfolio_group string names, by name or alias, within a fund.
-- ---------------------------------------------------------------------------
create or replace function public.vehicle_id_for_name(p_fund uuid, p_name text)
returns uuid
language sql
stable
set search_path = public
as $$
  select v.id from fund_vehicles v
   where v.fund_id = p_fund and p_name is not null
     and (v.name = p_name or p_name = any(v.aliases))
   order by (v.name = p_name) desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Recompute one company's links from every source, then rewrite its derived portfolio_group.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_company_vehicles(p_company uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fund uuid;
  v_groups text[];
  v_derived text[];
begin
  select fund_id, portfolio_group into v_fund, v_groups from companies where id = p_company;
  if v_fund is null then
    return;
  end if;

  with holding as (
    select vehicle_id_for_name(t.fund_id, t.portfolio_group) as vehicle_id
      from investment_transactions t where t.company_id = p_company and t.portfolio_group is not null
    union
    select a.vehicle_id from chart_of_accounts a where a.company_id = p_company and a.vehicle_id is not null
    union
    select h.vehicle_id from fund_holding_terms h where h.company_id = p_company and h.vehicle_id is not null
    union
    select vehicle_id_for_name(w.fund_id, w.portfolio_group)
      from crypto_wallets w where w.company_id = p_company and w.portfolio_group is not null
  ),
  assigned as (
    select vehicle_id_for_name(v_fund, g) as vehicle_id from unnest(coalesce(v_groups, '{}')) g
  ),
  wanted as (
    select vehicle_id, 'holding'::text as relation from holding where vehicle_id is not null
    union all
    select a.vehicle_id, 'assigned' from assigned a
     where a.vehicle_id is not null and not exists (select 1 from holding h where h.vehicle_id = a.vehicle_id)
  ),
  removed as (
    delete from company_vehicles cv
     where cv.company_id = p_company
       and not exists (select 1 from wanted w where w.vehicle_id = cv.vehicle_id)
  )
  insert into company_vehicles (fund_id, company_id, vehicle_id, relation)
  select distinct on (vehicle_id) v_fund, p_company, vehicle_id, relation from wanted
  on conflict (company_id, vehicle_id) do update set relation = excluded.relation
    where company_vehicles.relation is distinct from excluded.relation;

  -- Derived portfolio_group: every linked entity's name, PLUS any name that matches no entity — a
  -- legacy portfolio_group string with no registry row. Dropping those would lose data the derived
  -- array has no other place to keep. Only written when it changed, and the companies trigger ignores
  -- writes made from inside another trigger, so this cannot loop.
  select coalesce(array_agg(n order by n), '{}')
    into v_derived
    from (
      select v.name as n
        from company_vehicles cv join fund_vehicles v on v.id = cv.vehicle_id
       where cv.company_id = p_company
      union
      select g from unnest(coalesce(v_groups, '{}')) g
       where vehicle_id_for_name(v_fund, g) is null
    ) names;

  update companies set portfolio_group = v_derived
   where id = p_company and portfolio_group is distinct from v_derived;
end;
$$;

revoke execute on function public.refresh_company_vehicles(uuid) from public, anon, authenticated;
grant execute on function public.refresh_company_vehicles(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Triggers: any change to a source recomputes the companies it touched (old and new).
-- ---------------------------------------------------------------------------
create or replace function public.company_vehicles_source_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.company_id is not null then
    perform refresh_company_vehicles(old.company_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.company_id is not null then
    perform refresh_company_vehicles(new.company_id);
  end if;
  return null;
end;
$$;

revoke execute on function public.company_vehicles_source_changed() from public, anon, authenticated;

drop trigger if exists company_vehicles_from_transactions on public.investment_transactions;
create trigger company_vehicles_from_transactions
  after insert or update of company_id, portfolio_group or delete on public.investment_transactions
  for each row execute function public.company_vehicles_source_changed();

drop trigger if exists company_vehicles_from_accounts on public.chart_of_accounts;
create trigger company_vehicles_from_accounts
  after insert or update of company_id, vehicle_id or delete on public.chart_of_accounts
  for each row execute function public.company_vehicles_source_changed();

drop trigger if exists company_vehicles_from_holding_terms on public.fund_holding_terms;
create trigger company_vehicles_from_holding_terms
  after insert or update of company_id, vehicle_id or delete on public.fund_holding_terms
  for each row execute function public.company_vehicles_source_changed();

drop trigger if exists company_vehicles_from_wallets on public.crypto_wallets;
create trigger company_vehicles_from_wallets
  after insert or update of company_id, portfolio_group or delete on public.crypto_wallets
  for each row execute function public.company_vehicles_source_changed();

-- A direct edit to a company's portfolio_group (the company form) is an assignment. Writes made by
-- refresh_company_vehicles itself arrive at trigger depth > 1 and are ignored.
create or replace function public.company_vehicles_from_company()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() = 1 then
    perform refresh_company_vehicles(new.id);
  end if;
  return null;
end;
$$;

revoke execute on function public.company_vehicles_from_company() from public, anon, authenticated;

drop trigger if exists company_vehicles_from_company on public.companies;
create trigger company_vehicles_from_company
  after insert or update of portfolio_group on public.companies
  for each row execute function public.company_vehicles_from_company();

-- An entity's name or aliases changing — a rename, an alias added, an entity created that an existing
-- portfolio_group string already names — changes which companies its name links. Renaming retags the
-- strings to the new name BEFORE renaming the row (lib/vehicles.ts), so for a moment the new name
-- matches nothing and those links drop; this puts them back once the row says the new name.
create or replace function public.company_vehicles_from_vehicle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
begin
  for c in select id from companies where fund_id = new.fund_id loop
    perform refresh_company_vehicles(c.id);
  end loop;
  return null;
end;
$$;

revoke execute on function public.company_vehicles_from_vehicle() from public, anon, authenticated;

drop trigger if exists company_vehicles_from_vehicle on public.fund_vehicles;
create trigger company_vehicles_from_vehicle
  after insert or update of name, aliases on public.fund_vehicles
  for each row execute function public.company_vehicles_from_vehicle();

-- ---------------------------------------------------------------------------
-- Backfill every company once (re-runnable: refresh is idempotent).
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in select id from public.companies loop
    perform public.refresh_company_vehicles(c.id);
  end loop;
end $$;

-- A fund with ONE entity has only one possible answer for a company tagged to none: that entity.
-- Assigning it means pushing this does not hide the fund's untagged companies from its members (a
-- company linked to no entity is admin-only). A fund with several entities has no single right
-- answer, so its untagged companies stay unassigned for an admin to place — list them with
-- scripts/check-unlinked-companies.sql before pushing. Writing portfolio_group fires the companies
-- trigger, which records the assignment.
update public.companies c
   set portfolio_group = array[v.name]
  from public.fund_vehicles v
 where v.fund_id = c.fund_id
   and v.active and v.kind <> 'manco'
   and (select count(*) from public.fund_vehicles o where o.fund_id = c.fund_id and o.active and o.kind <> 'manco') = 1
   and not exists (select 1 from public.company_vehicles cv where cv.company_id = c.id);

-- ---------------------------------------------------------------------------
-- Deals carry their owning entity from the start; visibility follows it.
-- ---------------------------------------------------------------------------
alter table public.inbound_deals
  add column if not exists vehicle_id uuid references public.fund_vehicles(id) on delete set null;

create index if not exists inbound_deals_vehicle_idx on public.inbound_deals (fund_id, vehicle_id);
