-- supabase/migrations/20261009700000_saved_dashboards.sql
--
-- Saved dashboards: what a member asks an assistant (Claude, ChatGPT) to keep, so that "open my Q3
-- LP dashboard" works in any later conversation. Neither assistant keeps a rendered view beyond
-- the conversation it appeared in, and the plugin has no storage of its own, so the one place a
-- dashboard can persist that both reach is this deployment's database.
--
-- A row is a RECIPE, never a result: a name, which of the four views it is, and the arguments
-- that produce it (a vehicle, a company id, a statement period). No figure is stored. Opening one
-- runs the view again as the person opening it, through the same access check as calling the
-- view's tool directly (lib/agent/dashboard-tools.ts `viewDenial`), so a shared dashboard cannot
-- carry its author's access to a colleague.
--
-- Additive, and nothing deployed reads it yet, so it needs no release to ship first. The code
-- that reads it tolerates its absence (lib/mcp-apps/saved-dashboards.ts `isMissingTable`): until
-- this is applied the standard dashboards still open and saving says a migration is pending.

create table public.saved_dashboards (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references funds(id) on delete cascade,
  -- The member who saved it. Their dashboards go with them if the account is deleted.
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  view text not null check (view in ('portfolio', 'company', 'statements', 'lps')),
  -- The view's arguments. The application reduces this to known string keys on the way in AND on
  -- the way out (sanitizeArguments), so a row edited by hand is still only replayed as those.
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  -- Listed for every member of the fund. Each still sees only what their own access allows.
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One dashboard per name per member, case-insensitively: saving under a name you already have
-- replaces it, and "Q3 LPs" and "q3 lps" are the same dashboard to the person asking for it.
create unique index saved_dashboards_owner_name_key
  on public.saved_dashboards (fund_id, user_id, lower(name));

-- The shared list is read by fund.
create index saved_dashboards_fund_shared_idx
  on public.saved_dashboards (fund_id) where shared;

-- 1. Grants. SERVICE ROLE ONLY, reads included.
--
--    The only reader and writer is the MCP endpoint, which holds the service-role key and scopes
--    every query to the credential's fund and member. The ordinary template (authenticated gets
--    CRUD, RLS scopes the rows) would be wrong here for the reason CLAUDE.md gives: a grant knows
--    nothing about domains. A dashboard's name and arguments name a company or a vehicle, and a
--    fund-membership policy would hand a colleague's shared "Carry by partner" recipe to a member
--    the application refuses to list it for (list_dashboards filters by the view's domain).
--
--    Revoke first: projects created before 2026-05-30 still auto-grant new public tables to
--    anon and authenticated.
revoke all on public.saved_dashboards from anon, authenticated;
grant select, insert, update, delete on public.saved_dashboards to service_role;

-- 2. RLS on, with NO policies: if a grant ever creeps back, every row is still denied.
alter table public.saved_dashboards enable row level security;
