-- The management fee schedule, one stored row per period (lib/accounting/fee-periods.ts).
--
-- `vehicle_accounting_settings.fee_schedule` holds the LPA's wording (frequency, dates, rate steps,
-- bases, offsets). These rows are what that wording charges, period by period, written out so an
-- admin can see each payment and change it: the dates, the due date, the rate and basis, the capital
-- the fee is calculated on, the fee, and per-partner lines for a later closer's catch-up, an
-- equalization fee or any other adjustment. Regenerating from the terms rewrites only rows nobody
-- has edited and nothing has posted; an edited row is kept as the admin left it.
--
-- Posting a period books the fund side (Dr management fee / Cr due to the manager, each partner's
-- capital charged its own line through the 3200 bridge) and, when a management company is linked
-- to the fund, the manager side (Dr due from the fund / Cr management fee income). Each payment
-- also gets an invoice from the manager to the fund, numbered and kept on the row.
--
-- Read and written only by the accounting routes and MCP tools (service role), like
-- partnership_invoices: no grant to anon or authenticated, and no policies, so RLS denies by
-- default if a grant ever creeps back.

create table public.management_fee_periods (
  id              uuid primary key default gen_random_uuid(),
  fund_id         uuid not null references funds(id) on delete cascade,
  vehicle_id      uuid not null references fund_vehicles(id) on delete cascade,
  period_start    date not null,
  -- Exclusive: the next period's first day.
  period_end      date not null,
  due_date        date not null,
  -- The annual rate and basis in force (or as the admin set them).
  rate            numeric(9, 6) not null default 0,
  basis           text not null default 'commitments' check (basis in ('commitments', 'invested', 'nav', 'other')),
  -- The capital the fee is calculated on.
  basis_amount    numeric(20, 2) not null default 0,
  gross           numeric(20, 2) not null default 0,
  offset_amount   numeric(20, 2) not null default 0,
  note            text,
  -- An admin changed it: regenerating leaves it alone.
  edited          boolean not null default false,
  status          text not null default 'scheduled' check (status in ('scheduled', 'drafted', 'posted', 'waived')),
  -- What has been booked for it: [{ date, entryId, managerEntryId?, chargeId?, amount }]. One slice
  -- on the due date, or one per month when the vehicle accrues the fee monthly.
  postings        jsonb not null default '[]'::jsonb check (jsonb_typeof(postings) = 'array'),
  last_error      text,
  invoice_number  text,
  invoice_date    date,
  invoice_status  text check (invoice_status is null or invoice_status in ('draft', 'issued', 'void')),
  invoice_amount  numeric(20, 2),
  -- Bumped each time an invoice is voided, so a reissue gets the next number.
  invoice_seq     integer not null default 0,
  edited_by       uuid references auth.users(id) on delete set null,
  edited_at       timestamptz,
  posted_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint management_fee_periods_dates check (period_end > period_start),
  unique (vehicle_id, period_start)
);
create index management_fee_periods_vehicle_idx on public.management_fee_periods (fund_id, vehicle_id, period_start);
create index management_fee_periods_due_idx on public.management_fee_periods (status, due_date);
create unique index management_fee_periods_invoice_idx
  on public.management_fee_periods (fund_id, invoice_number)
  where invoice_number is not null and invoice_status in ('draft', 'issued');

create table public.management_fee_period_lines (
  id            uuid primary key default gen_random_uuid(),
  fund_id       uuid not null references funds(id) on delete cascade,
  period_id     uuid not null references public.management_fee_periods(id) on delete cascade,
  lp_entity_id  uuid not null references lp_entities(id) on delete cascade,
  -- fee: the partner's share of the period's fee. catch_up: a later closer's fee for the periods
  -- before it was admitted. equalization: an equalization fee charged with it. adjustment: anything
  -- else an admin adds (negative for a credit).
  kind          text not null default 'fee' check (kind in ('fee', 'catch_up', 'equalization', 'adjustment')),
  basis_amount  numeric(20, 2),
  rate          numeric(9, 6),
  amount        numeric(20, 2) not null,
  -- Generated from the terms (true) or typed by an admin (false).
  auto          boolean not null default true,
  note          text,
  created_at    timestamptz not null default now()
);
create index management_fee_period_lines_period_idx on public.management_fee_period_lines (period_id);

-- Grants: service role only (see the header).
revoke all on public.management_fee_periods from anon, authenticated;
revoke all on public.management_fee_period_lines from anon, authenticated;
grant select, insert, update, delete on public.management_fee_periods to service_role;
grant select, insert, update, delete on public.management_fee_period_lines to service_role;

alter table public.management_fee_periods enable row level security;
alter table public.management_fee_period_lines enable row level security;
