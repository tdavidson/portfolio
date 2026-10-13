-- Quarter-end close checklists: the tasks between a quarter-end and the LP reporting date, who owns
-- each, when it is due, and — separately — whether its numbers have been tied out.
--
-- A checklist is generated (lib/close-checklist/template.ts) from the fund's kind, its number of
-- portfolio companies, who administers it and the LP delivery date; each task's due date is counted
-- back from that delivery date (`days_before_delivery`), so moving the date moves every task that
-- has not been given its own date (`due_date_overridden`).
--
-- "Done" and "tied out" are two columns on purpose: a finished task is not a verified number.
-- Tying out is recorded with who did it and when, and the service refuses a tie-out by the person
-- who completed the task (an admin may override with a note, which the audit trail keeps).
--
-- Read and written only through the close-checklist service — the /api/accounting/close-checklists
-- routes and the close_checklist_* agent tools — with the service role, after their own accounting
-- gate. So, per CLAUDE.md, both tables are granted to service_role alone with RLS on and no
-- authenticated policies.

create table public.close_checklists (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  -- Null = the whole fund; otherwise one entity's close.
  vehicle_id uuid references public.fund_vehicles(id) on delete cascade,
  title text not null,
  period_end date not null,
  lp_delivery_date date not null,
  fund_kind text not null default 'venture',
  portfolio_company_count integer,
  -- A name, 'outsourced', or null for an in-house team.
  administrator text,
  status text not null default 'open',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint close_checklists_fund_kind check (fund_kind in ('venture', 'pe')),
  constraint close_checklists_status check (status in ('open', 'delivered', 'archived')),
  constraint close_checklists_dates check (lp_delivery_date > period_end),
  constraint close_checklists_title_len check (char_length(title) between 1 and 200),
  constraint close_checklists_companies check (portfolio_company_count is null or portfolio_company_count between 0 and 10000),
  constraint close_checklists_one_per_period unique nulls not distinct (fund_id, vehicle_id, period_end)
);

create index close_checklists_fund_idx on public.close_checklists (fund_id, period_end desc);

create table public.close_checklist_tasks (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.close_checklists(id) on delete cascade,
  fund_id uuid not null references public.funds(id) on delete cascade,
  -- Stable within a checklist; what `depends_on` refers to.
  key text not null,
  title text not null,
  description text,
  owner_group text not null,
  -- Who in that group: the administrator's name, a team member, "each company's CFO".
  assignee text,
  days_before_delivery integer not null default 0,
  due_date date not null,
  due_date_overridden boolean not null default false,
  depends_on text[] not null default '{}',
  sort_order integer not null default 0,
  status text not null default 'not_started',
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  tie_out_status text not null default 'pending',
  tied_out_by uuid references auth.users(id) on delete set null,
  tied_out_at timestamptz,
  tie_out_note text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint close_checklist_tasks_owner check (owner_group in ('administrator', 'portfolio_companies', 'internal')),
  constraint close_checklist_tasks_status check (status in ('not_started', 'in_progress', 'done', 'not_applicable')),
  constraint close_checklist_tasks_tie_out check (tie_out_status in ('not_required', 'pending', 'tied_out', 'exception')),
  -- A number can only be tied out once the work that produced it is finished.
  constraint close_checklist_tasks_tied_out_done check (tie_out_status <> 'tied_out' or status = 'done'),
  constraint close_checklist_tasks_title_len check (char_length(title) between 1 and 300),
  constraint close_checklist_tasks_key unique (checklist_id, key)
);

create index close_checklist_tasks_checklist_idx on public.close_checklist_tasks (checklist_id, sort_order);
create index close_checklist_tasks_fund_idx on public.close_checklist_tasks (fund_id);

create trigger close_checklists_updated_at before update on public.close_checklists
  for each row execute function public.set_updated_at();
create trigger close_checklist_tasks_updated_at before update on public.close_checklist_tasks
  for each row execute function public.set_updated_at();

-- 1. Grants: service role only (see header). Revoked explicitly too: projects created before the
--    2026 Data API change grant new tables to anon/authenticated automatically.
revoke all on public.close_checklists from anon, authenticated;
revoke all on public.close_checklist_tasks from anon, authenticated;
grant select, insert, update, delete on public.close_checklists to service_role;
grant select, insert, update, delete on public.close_checklist_tasks to service_role;

-- 2. RLS on, and no policies: if a grant ever crept back, RLS would still deny.
alter table public.close_checklists enable row level security;
alter table public.close_checklist_tasks enable row level security;
