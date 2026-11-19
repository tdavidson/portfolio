-- Vehicles whose fund administrator keeps the books (lib/admin-reporting).
--
-- An `admin` vehicle reports what its administrator states and nothing else: each LP's commitment,
-- paid-in, distributions and NAV as of a quarter end, and the fund's net LP-only IRR, TVPI and DPI
-- for that date, shown on every LP's row. The app recalculates none of it. A `books` vehicle (the
-- default, and every vehicle today) is unchanged.
--
-- A pull takes the administrator's figures for one vehicle and one date. It is checked only for being
-- complete and matched to the vehicle's partners, then saved: the positions go to lp_positions (one
-- row per LP per date, as before) and the fund figures to vehicle_reported_figures. admin_pulls keeps
-- each saved pull as it arrived, so every stored figure can be traced to where and when it came from.
--
-- Additive. Nothing reads the new columns until the release that writes them is deployed, and the
-- readers treat a missing column as `books`.

-- 1. The vehicle's record source.
alter table public.fund_vehicles
  add column if not exists record_source text not null default 'books'
    check (record_source in ('books', 'admin')),
  -- Which administrator, for the pull's adapter. Null on a books vehicle.
  add column if not exists admin_provider text
    check (admin_provider is null or admin_provider in ('carta', 'csv', 'other')),
  -- The vehicle's id at the administrator (Carta's fund UUID, say), so a pull reads the right fund.
  add column if not exists admin_fund_ref text
    check (admin_fund_ref is null or length(trim(admin_fund_ref)) between 1 and 200);

-- 2. Saved pulls. Service role only: they hold partners' capital, and their only readers are gated
--    routes and assistant tools holding the service-role key (as vehicle_reported_figures).
create table if not exists public.admin_pulls (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  vehicle_id uuid not null references public.fund_vehicles(id) on delete cascade,
  as_of date not null,
  -- The administrator the figures came from, as the reader names it ("Carta", "CSV upload").
  source text not null check (length(trim(source)) between 1 and 200),
  -- Which door the pull came through.
  channel text not null check (channel in ('app', 'mcp', 'api')),
  -- The figures as saved (normalised), and the response or file as it arrived, for tracing.
  figures jsonb not null,
  raw jsonb,
  -- The completeness and matching results shown before saving.
  flags jsonb not null default '{}'::jsonb,
  status text not null default 'saved' check (status in ('saved', 'superseded')),
  saved_by uuid references auth.users(id) on delete set null,
  saved_at timestamptz not null default now()
);

create index if not exists admin_pulls_vehicle_idx
  on public.admin_pulls (fund_id, vehicle_id, as_of desc, saved_at desc);

revoke all on public.admin_pulls from anon, authenticated;
grant select, insert, update, delete on public.admin_pulls to service_role;
alter table public.admin_pulls enable row level security;

comment on table public.admin_pulls is
  'Fund administrator figures saved for an admin-reported vehicle, as they arrived. Stated, never computed here.';

-- 3. Which app partner each administrator partner is, per vehicle. Set the first time a partner is
--    matched; later pulls match by the administrator's id. Service role only, like the pulls.
create table if not exists public.admin_lp_links (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  vehicle_id uuid not null references public.fund_vehicles(id) on delete cascade,
  external_id text not null check (length(trim(external_id)) between 1 and 200),
  lp_entity_id uuid not null references public.lp_entities(id) on delete cascade,
  external_name text,
  created_at timestamptz not null default now(),
  unique (vehicle_id, external_id)
);

create index if not exists admin_lp_links_fund_idx on public.admin_lp_links (fund_id, vehicle_id);

revoke all on public.admin_lp_links from anon, authenticated;
grant select, insert, update, delete on public.admin_lp_links to service_role;
alter table public.admin_lp_links enable row level security;

-- 4. Positions remember the pull they came from, and carry the call receivable where stated.
alter table public.lp_positions
  add column if not exists pull_id uuid references public.admin_pulls(id) on delete set null,
  add column if not exists receivable numeric;

alter table public.lp_positions drop constraint if exists lp_positions_source_check;
alter table public.lp_positions add constraint lp_positions_source_check
  check (source in ('paste', 'manual', 'migrated', 'admin'));
