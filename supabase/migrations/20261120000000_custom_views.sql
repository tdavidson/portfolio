-- supabase/migrations/20261120000000_custom_views.sql
--
-- Custom views: a member describes a screen in words ("NAV, unfunded and the largest positions,
-- filterable by vehicle"), an assistant writes it down as a spec of blocks over the query datasets,
-- and the app draws it live at /views/<id> and in a connected chat.
--
-- A row is a RECIPE, never a result, exactly as saved_dashboards is: a name, and a spec of blocks
-- from a fixed set (tiles, bar and line charts, tables, text), each naming a query dataset and a
-- query. No figure, HTML or code is stored. Opening a view loads every block again as the person
-- opening it, through that dataset's own access check (lib/custom-views/resolve.ts), so a shared
-- view cannot carry its author's access to a colleague.
--
-- Additive. The code that reads these tables tolerates their absence (lib/custom-views/store.ts
-- `isMissingTable`): until this is applied, previewing a view in chat works and saving says a
-- migration is pending.

create table public.custom_views (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references funds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  -- Validated by the application on the way in AND on the way out (lib/custom-views/spec.ts), so a
  -- row edited by hand is still only ever replayed as known blocks over known columns.
  spec jsonb not null check (jsonb_typeof(spec) = 'object'),
  -- Listed for every member of the fund. Each still sees only what their own access allows.
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One view per name per member, case-insensitively: saving under a name you have replaces it.
create unique index custom_views_owner_name_key
  on public.custom_views (fund_id, user_id, lower(name));

create index custom_views_fund_shared_idx
  on public.custom_views (fund_id) where shared;

-- Every saved spec, so a change can be compared and rolled back.
create table public.custom_view_versions (
  id uuid primary key default gen_random_uuid(),
  view_id uuid not null references public.custom_views(id) on delete cascade,
  fund_id uuid not null references funds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  spec jsonb not null check (jsonb_typeof(spec) = 'object'),
  created_at timestamptz not null default now()
);

create index custom_view_versions_view_idx
  on public.custom_view_versions (view_id, created_at desc);

-- Grants: SERVICE ROLE ONLY, reads included, as for saved_dashboards. The only readers and
-- writers are the app's /api/views routes and the MCP endpoint, which hold the service-role key
-- and scope every query to the caller's fund and member. A fund-membership grant would hand a
-- colleague's shared spec to members the app would not list it for.
--
-- Revoke first: projects created before 2026-05-30 still auto-grant new public tables to anon and
-- authenticated.
revoke all on public.custom_views from anon, authenticated;
revoke all on public.custom_view_versions from anon, authenticated;
grant select, insert, update, delete on public.custom_views to service_role;
grant select, insert, update, delete on public.custom_view_versions to service_role;

-- RLS on, with NO policies: if a grant ever creeps back, every row is still denied.
alter table public.custom_views enable row level security;
alter table public.custom_view_versions enable row level security;
