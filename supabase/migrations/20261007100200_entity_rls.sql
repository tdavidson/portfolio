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
-- The funds whose data the caller sees unscoped: where they are an admin, or a member holding the
-- "All entities" grant (the same rule as access_context's `vehicles_all`).
create or replace function public.unscoped_fund_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(m.fund_id), '{}'::uuid[]) from fund_members m
   where m.user_id = auth.uid() and (m.role in ('admin', 'viewer') or m.all_entities);
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

-- The funds the caller is a member of. Name-based predicates pair with it: a group NAME is only text,
-- so "Fund I" in another tenant must not match — the permissive domain policies already bind the
-- fund, and this keeps the entity layer correct on its own rather than leaning on them.
create or replace function public.member_fund_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(m.fund_id), '{}'::uuid[]) from fund_members m where m.user_id = auth.uid();
$$;

revoke execute on function public.member_fund_ids() from public, anon;
grant execute on function public.member_fund_ids() to authenticated, service_role;

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
  wpred text;
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
    -- relationships: an interaction about a company is that company's
    'interactions',
    -- staged AI/agent writes: an action on an entity is that entity's
    'pending_actions',
    -- compliance: an entity's filings and deadlines are that entity's; '' is fund-level
    'compliance_filings', 'compliance_deadlines', 'compliance_fund_settings',
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
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or id = any((select public.vehicle_ids_readable())::uuid[])'
      -- Mail and parsing reviews about no company: unmatched, possibly about anyone's company — for
      -- unscoped callers to triage, as in the app (and the email-attachments storage rule).
      when t in ('inbound_emails', 'parsing_reviews') then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or company_id = any((select public.company_ids_readable())::uuid[])'
      -- Compliance rows name their entity in portfolio_group; '' is the fund's own (every member's).
      when t in ('compliance_filings', 'compliance_deadlines', 'compliance_fund_settings') then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or (fund_id = any((select public.member_fund_ids())::uuid[]) '
        || 'and (portfolio_group = '''' or portfolio_group = any((select public.group_names_readable())::text[])))'
      -- Update requests are fund-wide mailings naming every company's contacts.
      when t = 'email_requests' then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[])'
      when t = 'companies' then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or id = any((select public.company_ids_readable())::uuid[])'
      when t = 'inbound_deals' then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or vehicle_id = any((select public.vehicle_ids_readable())::uuid[])'
      when 'vehicle_id' = any(cols) then
        'vehicle_id = any((select public.vehicle_ids_readable())::uuid[]) or (vehicle_id is null and fund_id = any((select public.unscoped_fund_ids())::uuid[]))'
      when 'portfolio_group' = any(cols) and 'company_id' = any(cols) then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or case when portfolio_group is null '
        || 'then company_id = any((select public.company_ids_readable())::uuid[]) '
        || 'else (fund_id = any((select public.member_fund_ids())::uuid[]) and portfolio_group = any((select public.group_names_readable())::text[])) end'
      when 'portfolio_group' = any(cols) then
        'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or (fund_id = any((select public.member_fund_ids())::uuid[]) '
        || 'and portfolio_group = any((select public.group_names_readable())::text[]))'
      when 'company_id' = any(cols) then
        'company_id is null or fund_id = any((select public.unscoped_fund_ids())::uuid[]) or company_id = any((select public.company_ids_readable())::uuid[])'
      else null
    end;

    if pred is null then
      -- A listed table with no column to decide by is a mistake in this list, not a table to skip.
      raise exception 'entity RLS: no predicate for listed table %', t;
    end if;

    -- Writes also may not reach a company the caller cannot see: a row in their entity pointing at
    -- another entity's company would link that company to them (company_vehicles) and so reveal it.
    -- And a scoped member writes no company-wide (entity-less) price rows, as in the app.
    wpred := pred;
    if 'company_id' = any(cols) and t <> 'companies' then
      wpred := '(' || pred || ') and (fund_id = any((select public.unscoped_fund_ids())::uuid[]) '
        || 'or company_id is null or company_id = any((select public.company_ids_readable())::uuid[]))';
    end if;
    if 'portfolio_group' = any(cols) and 'company_id' = any(cols) then
      wpred := '(' || wpred || ') and (fund_id = any((select public.unscoped_fund_ids())::uuid[]) or portfolio_group is not null)';
    end if;

    execute format('drop policy if exists "Only the caller''s entities" on public.%I', t);
    execute format(
      'create policy "Only the caller''s entities" on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      t, pred, wpred);
  end loop;
end $$;

-- Compliance rows that hang off a deadline (no fund_id of their own) follow it: the subquery reads
-- compliance_deadlines as the caller, so its entity rule above applies.
do $$
declare
  t text;
begin
  foreach t in array array['compliance_workflows', 'compliance_entry_data'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('drop policy if exists "Only the caller''s entities" on public.%I', t);
    execute format(
      'create policy "Only the caller''s entities" on public.%I as restrictive for all to authenticated '
      || 'using (deadline_id in (select d.id from public.compliance_deadlines d)) '
      || 'with check (deadline_id in (select d.id from public.compliance_deadlines d))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- A company's entity tags (companies.portfolio_group) decide which entities it is assigned to
-- (company_vehicles). A scoped member who can see a shared company may change only THEIR entities'
-- tags on it: dropping another entity's tag would unlink the company from that entity, and adding
-- one would push it into an entity that is not theirs. Unscoped callers and the service role (no
-- JWT, auth.uid() null) are unaffected; so is the derived rewrite the link triggers make
-- (pg_trigger_depth() > 1), which recomputes tags from holdings rather than from the request.
-- ---------------------------------------------------------------------------
create or replace function public.companies_entity_tags_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or pg_trigger_depth() > 1 or new.fund_id = any(public.unscoped_fund_ids()) then
    return new;
  end if;
  if exists (
    select 1 from (
      (select unnest(coalesce(new.portfolio_group, '{}')) except select unnest(coalesce(old.portfolio_group, '{}')))
      union
      (select unnest(coalesce(old.portfolio_group, '{}')) except select unnest(coalesce(new.portfolio_group, '{}')))
    ) changed(g)
    where not changed.g = any(public.group_names_readable())
  ) then
    raise exception 'You can only change your own entities on a company' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.companies_entity_tags_guard() from public, anon, authenticated;

drop trigger if exists companies_entity_tags_guard on public.companies;
create trigger companies_entity_tags_guard
  before update of portfolio_group on public.companies
  for each row execute function public.companies_entity_tags_guard();
