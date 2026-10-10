-- Append-only history of a tax year's closes and reopens.
--
-- tax_year_closes holds one row per vehicle and year, and a re-close used to clear the last reopen's
-- who, when and why from it — so "closed, reopened in March because the underlying fund amended,
-- closed again" lost its middle. Each close and reopen now also lands here, and nothing updates or
-- deletes a row.
create table if not exists public.tax_year_close_events (
  id         uuid primary key default gen_random_uuid(),
  fund_id    uuid not null references funds(id) on delete cascade,
  vehicle_id uuid not null references fund_vehicles(id) on delete cascade,
  tax_year   int  not null,
  action     text not null check (action in ('closed', 'reopened')),
  actor_id   uuid,
  reason     text,
  created_at timestamptz not null default now()
);

create index if not exists tax_year_close_events_vehicle_year
  on public.tax_year_close_events (fund_id, vehicle_id, tax_year, created_at);

-- Grants: service_role ONLY, like every other tax table (see tests/tax-data-api-grants.test.ts).
-- Its only reader is the gated tax route holding the service-role key; a grant to authenticated
-- would hand it to members that gate refuses.
-- Projects created before the 2026 Data API change still grant new tables to anon/authenticated by
-- default, so take those back explicitly.
revoke all on public.tax_year_close_events from anon, authenticated;
grant select, insert on public.tax_year_close_events to service_role;

-- RLS on with no authenticated policies: denied by default if a grant ever creeps back.
alter table public.tax_year_close_events enable row level security;

-- Seed the history with the closes already on record, so a re-close does not start it from nothing.
insert into public.tax_year_close_events (fund_id, vehicle_id, tax_year, action, actor_id, reason, created_at)
select fund_id, vehicle_id, tax_year, 'closed', closed_by, null, closed_at
  from public.tax_year_closes
 where closed_at is not null and vehicle_id is not null;
insert into public.tax_year_close_events (fund_id, vehicle_id, tax_year, action, actor_id, reason, created_at)
select fund_id, vehicle_id, tax_year, 'reopened', reopened_by, reopened_reason, reopened_at
  from public.tax_year_closes
 where reopened_at is not null and vehicle_id is not null;
