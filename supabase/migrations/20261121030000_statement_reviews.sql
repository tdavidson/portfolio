-- Statement review (docs/spec/statement-review.md), stage 1: checks on structured input.
--
-- One row per run of the checks on one vehicle's package for one period. The latest run for a
-- period is that period's review; earlier runs stay as history. A row holds the package as it was
-- checked (partners matched), what each check did, and the findings.
--
-- Service role only, like admin_pulls: the rows hold partners' capital, and their only readers are
-- the LP-capital review route and the statement_review_* tools, which hold the service-role key.

create table if not exists public.statement_reviews (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  vehicle_id uuid not null references public.fund_vehicles(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  -- Whose statements: an administrator's package, or the app's own books (stage 6).
  source text not null check (source in ('administrator', 'books')),
  -- How the figures arrived: a saved administrator pull, a CSV, or a package given whole.
  input text not null check (input in ('admin_pull', 'csv', 'package')),
  admin_pull_id uuid references public.admin_pulls(id) on delete set null,
  package jsonb not null,
  checks jsonb not null default '[]'::jsonb,
  findings jsonb not null default '[]'::jsonb,
  -- Findings by severity: { "error": n, "warning": n, "info": n }.
  counts jsonb not null default '{}'::jsonb,
  -- { "amount": n, "navShare": n }: differences above the larger are errors, below it info.
  materiality jsonb not null default '{}'::jsonb,
  threshold numeric not null default 0,
  nav numeric,
  run_by uuid references auth.users(id) on delete set null,
  run_at timestamptz not null default now(),
  check (period_start <= period_end)
);

create index if not exists statement_reviews_vehicle_idx
  on public.statement_reviews (fund_id, vehicle_id, period_end desc, run_at desc);

revoke all on public.statement_reviews from anon, authenticated;
grant select, insert, update, delete on public.statement_reviews to service_role;
alter table public.statement_reviews enable row level security;

comment on table public.statement_reviews is
  'Statement review runs: a vehicle''s package for a period, the tie-out checks run on it and their findings. Never changes the figures it reviews.';
