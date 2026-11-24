-- Recurring journal entries (lib/accounting/recurring-entries.ts).
--
-- accounting_schedules held monthly fixed-line templates that only the close read, as suggestions.
-- They become recurring journal entries an admin creates and manages from the journal:
--
--   frequency     monthly, quarterly, semiannual or annual, on day_of_month (31 = the month's last
--                 day), counted from start_date's month;
--   mode          what each due date does: remind (the reminder digest lists it and the close
--                 suggests it), draft (the daily run saves a draft), or post (it posts it);
--   kind          fixed (the stored lines, the same every time) or management_fee_spread (each month
--                 end recognizes the share of the vehicle's management fee periods that month covers,
--                 out of prepaid fees and deferred revenue: lib/accounting/fee-periods.ts);
--   auto_from     the first date the daily run books on its own: the day the mode was last set to
--                 draft or post. Earlier dates are never booked unattended; a person reviews them.
--
-- Rows created before this migration keep their behaviour: monthly, fixed, mode remind.
-- Idempotent, so pasting it twice is safe.

alter table public.accounting_schedules
  drop constraint if exists accounting_schedules_frequency_check;
alter table public.accounting_schedules
  add constraint accounting_schedules_frequency_check
  check (frequency in ('monthly', 'quarterly', 'semiannual', 'annual'));

alter table public.accounting_schedules
  add column if not exists kind text not null default 'fixed',
  add column if not exists mode text not null default 'remind',
  add column if not exists template_key text,
  add column if not exists reminder_days smallint not null default 3,
  add column if not exists auto_from date,
  add column if not exists last_run_at timestamptz,
  add column if not exists last_error text,
  add column if not exists updated_by uuid;

alter table public.accounting_schedules drop constraint if exists accounting_schedules_kind_check;
alter table public.accounting_schedules
  add constraint accounting_schedules_kind_check check (kind in ('fixed', 'management_fee_spread'));
alter table public.accounting_schedules drop constraint if exists accounting_schedules_mode_check;
alter table public.accounting_schedules
  add constraint accounting_schedules_mode_check check (mode in ('remind', 'draft', 'post'));
alter table public.accounting_schedules drop constraint if exists accounting_schedules_reminder_days_check;
alter table public.accounting_schedules
  add constraint accounting_schedules_reminder_days_check check (reminder_days between 0 and 60);

-- One management fee spread per vehicle.
create unique index if not exists accounting_schedules_one_fee_spread
  on public.accounting_schedules (fund_id, vehicle_id) where kind = 'management_fee_spread';

-- The daily run's gate reads this: is any recurring entry set to book on its own?
create index if not exists accounting_schedules_auto_idx
  on public.accounting_schedules (mode) where active and mode in ('draft', 'post');

comment on table public.accounting_schedules is
  'Recurring journal entries: fixed lines (or a management fee spread) on a monthly, quarterly, semiannual or annual cadence, reminded, drafted or posted on each due date.';
