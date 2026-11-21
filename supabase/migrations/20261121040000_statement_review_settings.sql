-- Statement review settings (docs/spec/statement-review.md): one row per vehicle with the
-- reviewer's materiality, their own instructions, the accounts to watch every period and the
-- adjustments they already know about (a finding one of them explains is marked explained).
--
-- Service role only, like statement_reviews: read and written by the LP-capital review routes and
-- the statement_review_settings tools, which hold the service-role key.

create table if not exists public.statement_review_settings (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  vehicle_id uuid not null unique references public.fund_vehicles(id) on delete cascade,
  -- { "amount": n, "navShare": n }
  materiality jsonb not null default '{}'::jsonb,
  instructions text not null default '' check (length(instructions) <= 8000),
  -- [{ "account": "4100", "note": "...", "threshold": n }]
  watch_accounts jsonb not null default '[]'::jsonb,
  -- [{ "description": "...", "check": "cash", "subject": "...", "amount": n, "tolerance": n }]
  adjustments jsonb not null default '[]'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists statement_review_settings_fund_idx on public.statement_review_settings (fund_id);

revoke all on public.statement_review_settings from anon, authenticated;
grant select, insert, update, delete on public.statement_review_settings to service_role;
alter table public.statement_review_settings enable row level security;

comment on table public.statement_review_settings is
  'Per-vehicle statement review settings: materiality, the reviewer''s instructions, watched accounts and known adjustments.';
