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
--   companies              the company is linked (company_vehicles) to one of the caller's entities
--   vehicle_id             the row's entity is one of theirs; a row with no entity is admin-only
--   portfolio_group (text) the entity that name (or alias) denotes is one of theirs; a row with no
--                          entity is visible with its company when it has one (a company-wide price
--                          signal), else admin-only
--   company_id             the company is visible; a row about no company (a fund-wide note) stays
--
-- See plans/spec-entity-access-and-portfolio.md and lib/access/scope.ts (the same rules in code).

-- ---------------------------------------------------------------------------
-- Helpers. Security definer so policies can call them without recursing through RLS.
-- ---------------------------------------------------------------------------
create or replace function public.is_fund_admin(p_fund uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from fund_members m where m.fund_id = p_fund and m.user_id = auth.uid() and m.role = 'admin');
$$;

revoke execute on function public.is_fund_admin(uuid) from public, anon;
grant execute on function public.is_fund_admin(uuid) to authenticated, service_role;

create or replace function public.can_see_company(p_fund uuid, p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_fund_admin(p_fund)
      or exists (select 1 from company_vehicles cv
                  where cv.company_id = p_company
                    and cv.vehicle_id = any(public.vehicle_ids_readable()));
$$;

revoke execute on function public.can_see_company(uuid, uuid) from public, anon;
grant execute on function public.can_see_company(uuid, uuid) to authenticated, service_role;

create or replace function public.can_see_group(p_fund uuid, p_group text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_fund_admin(p_fund)
      or (p_group is not null and public.vehicle_id_for_name(p_fund, p_group) = any(public.vehicle_ids_readable()));
$$;

revoke execute on function public.can_see_group(uuid, text) from public, anon;
grant execute on function public.can_see_group(uuid, text) to authenticated, service_role;

-- vehicle_id_for_name is called from the definer helper above; keep it off the public API surface.
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
    'company_update_chunks', 'metrics', 'parsing_reviews', 'investment_transactions', 'inbound_emails',
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
        'public.can_see_company(fund_id, id)'
      when t = 'inbound_deals' then
        'public.is_fund_admin(fund_id) or vehicle_id = any((select public.vehicle_ids_readable())::uuid[])'
      when 'vehicle_id' = any(cols) then
        'vehicle_id = any((select public.vehicle_ids_readable())::uuid[]) or (vehicle_id is null and public.is_fund_admin(fund_id))'
      when 'portfolio_group' = any(cols) and 'company_id' = any(cols) then
        'case when portfolio_group is null then public.can_see_company(fund_id, company_id) else public.can_see_group(fund_id, portfolio_group) end'
      when 'portfolio_group' = any(cols) then
        'public.can_see_group(fund_id, portfolio_group)'
      when 'company_id' = any(cols) then
        'company_id is null or public.can_see_company(fund_id, company_id)'
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
