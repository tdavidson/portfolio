-- Entity access for the Data API: a signed-in member's browser can read these tables directly with
-- its JWT, so the entity rule has to hold in RLS as well as in application code.
--
-- Added as RESTRICTIVE policies, which Postgres ANDs with the existing permissive ones. The domain
-- policies (20260902174637_enforce_domain_access_rls.sql) are untouched and still decide WHAT a
-- member may read; these decide WHOSE. An admin's visible set is every entity in the fund, so the
-- added rule never narrows an admin.
--
-- Each table gets the predicate its columns call for, decided below from information_schema so a
-- table this install does not have is skipped rather than failing the migration:
--
--   companies              the company is linked (company_vehicles) to one of the caller's entities,
--                          or the caller is the fund's admin (who also sees unassigned companies)
--   vehicle_id             the row's entity is one of theirs; a row with no entity is admin-only
--   portfolio_group (text) the entity that name (or alias) denotes is one of theirs; a row with no
--                          entity is visible with its company when it has one (a company-wide price
--                          signal), else admin-only
--   company_id             the company is visible; a row about no company (a fund-wide note) stays
--
-- See plans/spec-entity-access-and-portfolio.md and lib/access/scope.ts (the same rules in code).

-- ---------------------------------------------------------------------------
-- Helpers. Argument-free and security definer, so a policy wraps each as `(select f())` — an
-- initplan Postgres evaluates ONCE per query, not once per row — and calls them without recursing
-- through RLS. A helper taking row arguments would run its subqueries for every row scanned, admins
-- included.
-- ---------------------------------------------------------------------------
-- The funds whose data the caller sees unscoped: where they are an admin, or a member granted every
-- entity (the same rule as access_context's `vehicles_all`).
create or replace function public.unscoped_fund_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(m.fund_id), '{}'::uuid[]) from fund_members m
   where m.user_id = auth.uid()
     and (m.role = 'admin' or not exists (
       select 1 from fund_vehicles v where v.fund_id = m.fund_id
          and not exists (select 1 from fund_member_vehicles g
                           where g.fund_id = m.fund_id and g.user_id = m.user_id and g.vehicle_id = v.id)));
$$;

revoke execute on function public.unscoped_fund_ids() from public, anon;
grant execute on function public.unscoped_fund_ids() to authenticated, service_role;

create or replace function public.company_ids_readable()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct cv.company_id), '{}'::uuid[]) from company_vehicles cv
   where cv.vehicle_id = any(public.vehicle_ids_readable());
$$;

revoke execute on function public.company_ids_readable() from public, anon;
grant execute on function public.company_ids_readable() to authenticated, service_role;

-- Names AND aliases: portfolio_group strings may carry either.
create or replace function public.group_names_readable()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct n), '{}'::text[])
    from fund_vehicles v, unnest(array[v.name] || v.aliases) n
   where v.id = any(public.vehicle_ids_readable());
$$;

revoke execute on function public.group_names_readable() from public, anon;
grant execute on function public.group_names_readable() to authenticated, service_role;

-- vehicle_id_for_name is used by the company_vehicles triggers; keep it off the public API surface.
revoke execute on function public.vehicle_id_for_name(uuid, text) from public, anon;
grant execute on function public.vehicle_id_for_name(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The policies.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  cols text[];
  pred text;
  tables text[] := array[
    -- portfolio
    'companies', 'company_documents', 'company_summaries', 'company_updates', 'company_update_artifacts',
    'company_update_chunks', 'metrics', 'metric_values', 'parsing_reviews', 'investment_transactions', 'inbound_emails',
    'email_requests', 'fund_group_config', 'fund_cash_flows', 'fund_capital_events', 'fund_holding_terms',
    'fund_nav_statements', 'company_notes',
    -- accounting
    'chart_of_accounts', 'journal_entries', 'journal_postings', 'fiscal_periods', 'bank_transactions',
    'allocation_runs', 'allocation_results', 'vehicle_accounting_settings', 'qb_account_mappings',
    'qb_import_runs', 'fund_construction_models', 'crypto_wallets', 'price_feeds',
    'close_allocation_rounding', 'journal_entry_allocations',
    -- the entities themselves, and deals
    'fund_vehicles', 'inbound_deals'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    select array_agg(column_name::text) into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = t
       and (column_name in ('vehicle_id', 'company_id', 'fund_id')
            or (column_name = 'portfolio_group' and data_type = 'text'));

    if not ('fund_id' = any(cols)) then
      continue;
    end if;

    pred := case
      when t = 'fund_vehicles' then
        'id = any((select public.vehicle_ids_readable())::uuid[])'
      when t = 'companies' then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or id = any((select public.company_ids_readable())::uuid[])'
      when t = 'inbound_deals' then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or vehicle_id = any((select public.vehicle_ids_readable())::uuid[])'
      when 'vehicle_id' = any(cols) then
        'vehicle_id = any((select public.vehicle_ids_readable())::uuid[]) or (vehicle_id is null and fund_id = any((select public.unscoped_fund_ids())::uuid[]))'
      when 'portfolio_group' = any(cols) and 'company_id' = any(cols) then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or case when portfolio_group is null '
        || 'then company_id = any((select public.company_ids_readable())::uuid[]) '
        || 'else portfolio_group = any((select public.group_names_readable())::text[]) end'
      when 'portfolio_group' = any(cols) then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or portfolio_group = any((select public.group_names_readable())::text[])'
      when 'company_id' = any(cols) then
        'company_id is null or fund_id = any((select public.unscoped_fund_ids())::uuid[]) or company_id = any((select public.company_ids_readable())::uuid[])'
      else null
    end;

    if pred is null then
      continue;
    end if;

    execute format('drop policy if exists "Only the caller''s entities" on public.%I', t);
    execute format(
      'create policy "Only the caller''s entities" on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      t, pred, pred);
  end loop;
end $$;
