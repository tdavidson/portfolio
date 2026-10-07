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

-- LP entities with a position in one of the caller's entities: a commitment, a position, capital
-- events, call or distribution lines (all keyed by vehicle_id), or a legacy lp_investments row
-- tagged to one of their entities' names.
create or replace function public.lp_entity_ids_readable()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  with v as (select unnest(public.vehicle_ids_readable()) as id),
  g as (select unnest(public.group_names_readable()) as name)
  select coalesce(array_agg(distinct e), '{}'::uuid[]) from (
    select lp_entity_id as e from commitment_events where vehicle_id in (select id from v)
    union select lp_entity_id from lp_positions where vehicle_id in (select id from v)
    union select lp_entity_id from lp_capital_events where vehicle_id in (select id from v)
    union select lp_entity_id from capital_call_lines where vehicle_id in (select id from v)
    union select lp_entity_id from distribution_lines where vehicle_id in (select id from v)
    union select entity_id from lp_investments where portfolio_group in (select name from g)
  ) s
  where e is not null;
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

-- ---------------------------------------------------------------------------
-- The policies.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  cols text[];
  pred text;
  admin_or_lp constant text :=
    'not (select public.is_fund_member()) or fund_id = any((select public.admin_fund_ids())::uuid[])';
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
        -- Fund-wide documents go to every LP, so every member may see them; an investor-scoped one
        -- only when it is shared with an investor the member can see.
        'scope = ''fund'' or exists (select 1 from lp_document_shares s where s.document_id = lp_documents.id '
        || 'and s.lp_investor_id = any((select public.lp_investor_ids_readable())::uuid[]))'
      when 'vehicle_id' = any(cols) then
        'vehicle_id = any((select public.vehicle_ids_readable())::uuid[])'
      when 'portfolio_group' = any(cols) then
        'portfolio_group = any((select public.group_names_readable())::text[])'
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
