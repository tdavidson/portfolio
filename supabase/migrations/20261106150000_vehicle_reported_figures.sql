-- Fund performance figures reported by another system (lib/accounting/reported-figures.ts).
--
-- Net TVPI, DPI and IRR are the fund administrator's figures, not a calculation of this app's. A
-- partner or an assistant records each one as the administrator reports it, as of a date, with its
-- source named. The investor letter's brief and the fund performance surfaces read them as stated;
-- nothing computes, reconciles or overwrites them.
--
-- Read and written by gated routes and assistant tools holding the service-role key only, so the
-- grants go to service_role alone and no member policies are written: RLS then denies members by
-- default if a grant ever creeps back.
--
-- Additive.

create table if not exists public.vehicle_reported_figures (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  vehicle_id uuid not null references public.fund_vehicles(id) on delete cascade,
  as_of date not null,
  metric text not null check (metric in ('tvpi', 'dpi', 'rvpi', 'irr', 'moic')),
  basis text not null check (basis in ('net', 'gross')),
  -- A multiple as a ratio (1.16), an IRR as a fraction (0.0473).
  value numeric not null,
  source text not null check (length(trim(source)) between 1 and 200),
  note text check (note is null or length(note) <= 1000),
  recorded_by uuid references auth.users(id) on delete set null,
  recorded_at timestamptz not null default now(),
  unique (vehicle_id, as_of, metric, basis)
);

create index if not exists vehicle_reported_figures_fund_idx
  on public.vehicle_reported_figures (fund_id, vehicle_id, as_of desc);

revoke all on public.vehicle_reported_figures from anon, authenticated;
grant select, insert, update, delete on public.vehicle_reported_figures to service_role;

alter table public.vehicle_reported_figures enable row level security;

comment on table public.vehicle_reported_figures is
  'Fund performance figures as another system (the fund administrator) reports them, as of a date, with the source named. Stated, never computed here.';

-- The entity's ids in other systems (its fund administrator's fund id, say), on its letter profile,
-- so an assistant reads the right fund there: [{ "system": "...", "id": "..." }]. Data only. The
-- profile already has its grants and policies; a new column follows the table's.
alter table public.lp_letter_profiles add column if not exists external_ids jsonb not null default '[]'::jsonb;
