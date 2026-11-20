-- Stored LP report figures, so the report cards and their PDF read the last result instead of
-- rebuilding every vehicle's capital accounts on every load.
--
-- fund_data_versions holds one counter per fund. Statement-level triggers bump it whenever any
-- table the live LP report reads changes, deletes included. lp_report_cache keeps the last
-- whole-fund report with the counter it was built at. A reader serves the stored report only while
-- the counter still matches, and rebuilds it otherwise (lib/accounting/live-report-cache.ts).
--
-- Both tables are read and written only by the server with the service-role key, behind gated
-- routes, so they are granted to service_role alone and carry no member policies.

create table public.fund_data_versions (
  fund_id    uuid primary key references public.funds(id) on delete cascade,
  version    bigint not null default 0,
  changed_at timestamptz not null default now()
);

create table public.lp_report_cache (
  fund_id      uuid primary key references public.funds(id) on delete cascade,
  data_version bigint not null,
  report       jsonb not null,
  computed_at  timestamptz not null default now()
);

grant select, insert, update, delete on public.fund_data_versions to service_role;
grant select, insert, update, delete on public.lp_report_cache to service_role;
alter table public.fund_data_versions enable row level security;
alter table public.lp_report_cache enable row level security;

create or replace function public.bump_fund_data_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.fund_data_versions as v (fund_id, version, changed_at)
      select distinct o.fund_id, 1, now() from old_rows o where o.fund_id is not null
      on conflict (fund_id) do update set version = v.version + 1, changed_at = now();
  else
    insert into public.fund_data_versions as v (fund_id, version, changed_at)
      select distinct n.fund_id, 1, now() from new_rows n where n.fund_id is not null
      on conflict (fund_id) do update set version = v.version + 1, changed_at = now();
  end if;
  return null;
end;
$$;

revoke execute on function public.bump_fund_data_version() from anon, authenticated, public;

-- Every table the live LP report reads, keyed by fund_id.
do $$
declare
  t text;
begin
  foreach t in array array[
    'journal_entries', 'journal_postings', 'chart_of_accounts', 'fiscal_periods',
    'lp_positions', 'lp_investments', 'lp_snapshots', 'lp_entities', 'lp_investors',
    'commitment_events', 'partner_allocation_terms', 'capital_opening_links',
    'fund_vehicles', 'fund_group_config', 'vehicle_accounting_settings', 'vehicle_gp_links',
    'vehicle_reported_figures', 'admin_pulls', 'fund_cash_flows'
  ] loop
    execute format('create trigger %I after insert on public.%I referencing new table as new_rows for each statement execute function public.bump_fund_data_version()', 'lp_report_version_ins_' || t, t);
    execute format('create trigger %I after update on public.%I referencing new table as new_rows for each statement execute function public.bump_fund_data_version()', 'lp_report_version_upd_' || t, t);
    execute format('create trigger %I after delete on public.%I referencing old table as old_rows for each statement execute function public.bump_fund_data_version()', 'lp_report_version_del_' || t, t);
  end loop;
end $$;
