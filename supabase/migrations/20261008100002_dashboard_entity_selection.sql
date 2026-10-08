-- supabase/migrations/20261008100002_dashboard_entity_selection.sql
--
-- The portfolio dashboard's entity picker: which entities a person sees there.
--
--   * fund_settings.dashboard_excluded_vehicle_ids — the fund-wide default an admin sets, which
--     everyone starts from until they save their own. Stored as EXCLUDED ids so an entity created
--     later shows by default. fund_settings already has its grants (data_api_grants_backfill) and
--     its admin-only write policies; this is an additive column.
--   * public.dashboard_preferences — one row per person: their saved selection, also as excluded
--     ids. A row with an empty list means "all entities" and overrides the fund default; no row
--     means "use the fund default". Private to its owner.
--
-- Additive and re-runnable. The app reads both with the service role and treats a missing column
-- or table as "no selection", so this can be pushed before or after the release that uses it.

alter table public.fund_settings
  add column if not exists dashboard_excluded_vehicle_ids uuid[] not null default '{}';

create table if not exists public.dashboard_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  fund_id uuid not null references public.funds(id) on delete cascade,
  excluded_vehicle_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists dashboard_preferences_fund_idx on public.dashboard_preferences (fund_id);

-- 1. Grants — required from 2026-05-30 onward for the Data API to see this table.
grant select on public.dashboard_preferences to anon;
grant select, insert, update, delete on public.dashboard_preferences to authenticated, service_role;

-- 2. RLS.
alter table public.dashboard_preferences enable row level security;

-- 3. Policies — a person reads and writes only their own row, in their own fund. anon has no
--    policy, so it sees nothing despite the select grant.
drop policy if exists "dashboard_preferences is private to its owner" on public.dashboard_preferences;
create policy "dashboard_preferences is private to its owner"
  on public.dashboard_preferences for all to authenticated
  using (fund_id = any(public.get_my_fund_ids()) and user_id = auth.uid())
  with check (fund_id = any(public.get_my_fund_ids()) and user_id = auth.uid());
