-- Entity access, phase 2: LPs. A member sees an LP when it has a position in one of their entities,
-- and only that entity's side of it — its commitment, capital, calls, distributions, letters. An
-- investor is visible when one of its LP entities is. Admins see every LP.
--
-- Same mechanism as 20261007100200_entity_rls.sql: RESTRICTIVE policies, ANDed with the existing
-- lp_capital / lp_relations domain policies, predicates chosen from each table's columns. One
-- difference: LP PORTAL users are signed-in users too, but not fund members — their own policies
-- (get_my_lp_investor_ids) decide what they see, so the entity rule lets non-members through and
-- applies only to the fund's own members.
--
-- See plans/spec-entity-access-and-portfolio.md (phase 2).

-- ---------------------------------------------------------------------------
-- Helpers: argument-free, security definer, wrapped as initplans by the policies.
-- ---------------------------------------------------------------------------

-- Is the caller a member of any fund at all? False for an LP portal account.
create or replace function public.is_fund_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from fund_members m where m.user_id = auth.uid());
$$;

revoke execute on function public.is_fund_member() from public, anon;
grant execute on function public.is_fund_member() to authenticated, service_role;

-- LP entities with a position in the given entities: a commitment, a position, capital events, call
-- or distribution lines, allocation terms, ownership or carry (all keyed by vehicle_id), membership
-- of one of the entities' closings (an LP admitted before any commitment is recorded), or a legacy
-- lp_investments row tagged with one of the given names in the same funds. Distinct ids, computed in
-- the database: the app calls this as an RPC rather than reading the position tables itself, which
-- would hit PostgREST's row cap and silently drop LPs.
create or replace function public.lp_entity_ids_for(p_vehicle_ids uuid[], p_names text[])
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  with v as (select unnest(coalesce(p_vehicle_ids, '{}'::uuid[])) as id),
  funds as (select distinct fund_id from fund_vehicles where id in (select id from v))
  select coalesce(array_agg(distinct e), '{}'::uuid[]) from (
    select lp_entity_id as e from commitment_events where vehicle_id in (select id from v)
    union select lp_entity_id from lp_positions where vehicle_id in (select id from v)
    union select lp_entity_id from lp_capital_events where vehicle_id in (select id from v)
    union select lp_entity_id from capital_call_lines where vehicle_id in (select id from v)
    union select lp_entity_id from distribution_lines where vehicle_id in (select id from v)
    union select lp_entity_id from partner_allocation_terms where vehicle_id in (select id from v)
    union select lp_entity_id from vehicle_partner_ownership where vehicle_id in (select id from v)
    union select lp_entity_id from carry_payments where vehicle_id in (select id from v)
    union select m.lp_entity_id from vehicle_closing_members m
            join vehicle_closings c on c.id = m.closing_id where c.vehicle_id in (select id from v)
    union select entity_id from lp_investments
           where portfolio_group = any(coalesce(p_names, '{}'::text[])) and fund_id in (select fund_id from funds)
  ) s
  where e is not null;
$$;

revoke execute on function public.lp_entity_ids_for(uuid[], text[]) from public, anon, authenticated;
grant execute on function public.lp_entity_ids_for(uuid[], text[]) to service_role;

-- The investors behind given LP entities — also an RPC, for the same reason.
create or replace function public.lp_investor_ids_for(p_entity_ids uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct investor_id), '{}'::uuid[]) from lp_entities
   where id = any(coalesce(p_entity_ids, '{}'::uuid[])) and investor_id is not null;
$$;

revoke execute on function public.lp_investor_ids_for(uuid[]) from public, anon, authenticated;
grant execute on function public.lp_investor_ids_for(uuid[]) to service_role;

-- The caller's own: the same rule over their entities, for RLS.
create or replace function public.lp_entity_ids_readable()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select public.lp_entity_ids_for(public.vehicle_ids_readable(), public.group_names_readable());
$$;

revoke execute on function public.lp_entity_ids_readable() from public, anon;
grant execute on function public.lp_entity_ids_readable() to authenticated, service_role;

create or replace function public.lp_investor_ids_readable()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct investor_id), '{}'::uuid[]) from lp_entities
   where id = any(public.lp_entity_ids_readable()) and investor_id is not null;
$$;

revoke execute on function public.lp_investor_ids_readable() from public, anon;
grant execute on function public.lp_investor_ids_readable() to authenticated, service_role;

-- The LP documents the caller may see: fund-wide ones; and an investor document tagged to one of
-- their entities (or to none), shared with an investor they can see. A document tagged to another
-- entity is that entity's, even when shared with an LP the caller also sees.
create or replace function public.lp_document_ids_readable()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  with inv as (select public.lp_investor_ids_readable() as ids),
       nm as (select public.group_names_readable() as names),
       mine as (select public.member_fund_ids() as ids)
  select coalesce(array_agg(d.id), '{}'::uuid[]) from lp_documents d, inv, nm, mine
   where d.fund_id = any(mine.ids)
     and (d.scope = 'fund'
          or ((d.vehicle is null or d.vehicle = any(nm.names))
              and exists (select 1 from lp_document_shares s
                           where s.document_id = d.id and s.lp_investor_id = any(inv.ids))));
$$;

revoke execute on function public.lp_document_ids_readable() from public, anon;
grant execute on function public.lp_document_ids_readable() to authenticated, service_role;

-- The LP letters the caller may see: those of their entities.
create or replace function public.lp_letter_ids_readable()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(l.id), '{}'::uuid[]) from lp_letters l
   where l.fund_id = any(public.member_fund_ids())
     and l.portfolio_group = any(public.group_names_readable());
$$;

revoke execute on function public.lp_letter_ids_readable() from public, anon;
grant execute on function public.lp_letter_ids_readable() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The policies.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  cols text[];
  pred text;
  -- Not a member OF THIS ROW'S FUND (an LP portal user — including a member of some other fund who
  -- is an LP here): their own policies decide. Unscoped members: everything.
  admin_or_lp constant text :=
    'not (fund_id = any((select public.member_fund_ids())::uuid[])) or fund_id = any((select public.unscoped_fund_ids())::uuid[])';
  tables text[] := array[
    -- lp_capital
    'lp_investors', 'lp_entities', 'lp_investments', 'lp_positions', 'lp_capital_events', 'commitment_events',
    'partner_allocation_terms', 'capital_calls', 'capital_call_lines', 'distributions', 'distribution_lines',
    'vehicle_closings', 'vehicle_closing_members',
    -- gp_economics
    'vehicle_partner_ownership', 'carry_payments', 'vehicle_waterfall_terms', 'vehicle_gp_links',
    -- lp_relations
    'lp_letters', 'lp_letter_shares', 'lp_documents', 'lp_document_shares', 'lp_snapshot_shares',
    'lp_live_report_shares', 'lp_messages', 'lp_access_events', 'lp_deliveries',
    'lp_onboarding_items', 'lp_onboarding_events'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    select array_agg(column_name::text) into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = t
       and (column_name in ('vehicle_id', 'fund_id', 'lp_entity_id', 'entity_id', 'lp_investor_id', 'gp_vehicle_id')
            or (column_name = 'portfolio_group' and data_type = 'text'));

    if not ('fund_id' = any(cols)) then
      continue;
    end if;

    pred := case
      when t = 'lp_entities' then
        'id = any((select public.lp_entity_ids_readable())::uuid[])'
      when t = 'lp_investors' then
        'id = any((select public.lp_investor_ids_readable())::uuid[])'
      when t = 'vehicle_gp_links' then
        -- A GP entity serving a fund: visible with either side.
        'gp_vehicle_id = any((select public.vehicle_ids_readable())::uuid[]) '
        || 'or served_vehicle_id = any((select public.vehicle_ids_readable())::uuid[])'
      when t = 'lp_documents' then
        -- See lp_document_ids_readable: fund-wide, or their entity's and shared with an LP they see.
        'id = any((select public.lp_document_ids_readable())::uuid[])'
      -- Rows about ONE item follow that item, not just the LP: a shared LP's share of, delivery of,
      -- or visit to another entity's document or letter is that entity's.
      when t = 'lp_document_shares' then
        'document_id = any((select public.lp_document_ids_readable())::uuid[]) '
        || 'and lp_investor_id = any((select public.lp_investor_ids_readable())::uuid[])'
      when t = 'lp_letter_shares' then
        'letter_id = any((select public.lp_letter_ids_readable())::uuid[]) '
        || 'and lp_investor_id = any((select public.lp_investor_ids_readable())::uuid[])'
      when t = 'vehicle_closing_members' then
        'closing_id in (select c.id from vehicle_closings c where c.vehicle_id = any((select public.vehicle_ids_readable())::uuid[])) '
        || 'and lp_entity_id = any((select public.lp_entity_ids_readable())::uuid[])'
      when t = 'lp_access_events' then
        'lp_investor_id = any((select public.lp_investor_ids_readable())::uuid[]) and case target_type '
        || 'when ''document'' then target_id = any((select public.lp_document_ids_readable())::uuid[]) '
        || 'when ''letter'' then target_id = any((select public.lp_letter_ids_readable())::uuid[]) '
        || 'else true end'
      when t = 'lp_deliveries' then
        '(lp_investor_id = any((select public.lp_investor_ids_readable())::uuid[]) '
        || 'or lp_entity_id = any((select public.lp_entity_ids_readable())::uuid[])) and case kind '
        || 'when ''document'' then item_id = any((select public.lp_document_ids_readable())::uuid[]) '
        || 'when ''letter'' then item_id = any((select public.lp_letter_ids_readable())::uuid[]) '
        || 'else true end'
      when 'vehicle_id' = any(cols) then
        'vehicle_id = any((select public.vehicle_ids_readable())::uuid[])'
      when 'portfolio_group' = any(cols) then
        'fund_id = any((select public.member_fund_ids())::uuid[]) and portfolio_group = any((select public.group_names_readable())::text[])'
      when 'lp_entity_id' = any(cols) then
        'lp_entity_id = any((select public.lp_entity_ids_readable())::uuid[])'
      when 'entity_id' = any(cols) then
        'entity_id = any((select public.lp_entity_ids_readable())::uuid[])'
      when 'lp_investor_id' = any(cols) then
        'lp_investor_id = any((select public.lp_investor_ids_readable())::uuid[])'
      else null
    end;

    if pred is null then
      continue;
    end if;

    pred := admin_or_lp || ' or (' || pred || ')';

    execute format('drop policy if exists "Only the caller''s entities" on public.%I', t);
    execute format(
      'create policy "Only the caller''s entities" on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      t, pred, pred);
  end loop;
end $$;
