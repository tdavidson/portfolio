-- An audit trail for the books: who did what to an entry, a period, a commitment or a shared
-- report, when, and why.
--
-- user_activity_logs is not this. A fund can switch it off (fund_settings.disable_user_tracking),
-- and it records page activity, not changes to the books. Before this table, voiding a posted
-- entry, reopening a closed period, or editing a partner's commitment left no record of who did it
-- or the reason; re-closing a period overwrote its review.
--
-- Append-only and service-role only: written by the gated routes, never edited, never deleted.
create table if not exists public.accounting_audit_events (
  id           uuid primary key default gen_random_uuid(),
  fund_id      uuid not null references funds(id) on delete cascade,
  -- No foreign key: the record outlives the entity it describes, unchanged.
  vehicle_id   uuid,
  actor_id     uuid,
  -- e.g. entry.void, entry.unpost, entry.reverse, entry.post, period.close, period.reopen,
  -- close.approve, commitment.edit, commitment.delete, snapshot.share, k1.finalize
  action       text not null,
  subject_type text not null,
  subject_id   text,
  reason       text,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists accounting_audit_events_fund_created
  on public.accounting_audit_events (fund_id, created_at desc);
create index if not exists accounting_audit_events_subject
  on public.accounting_audit_events (fund_id, subject_type, subject_id);

revoke all on public.accounting_audit_events from anon, authenticated;
grant select, insert on public.accounting_audit_events to service_role;
alter table public.accounting_audit_events enable row level security;

-- Nothing may change a recorded event, service role included. The one delete allowed is the
-- cascade when the whole fund is deleted (fired from the foreign key, so one trigger level down).
create or replace function public.accounting_audit_events_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'accounting_audit_events is append-only';
end $$;
drop trigger if exists accounting_audit_events_no_change on public.accounting_audit_events;
create trigger accounting_audit_events_no_change
  before update or delete on public.accounting_audit_events
  for each row execute function public.accounting_audit_events_immutable();
