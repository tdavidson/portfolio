-- PENDING DEPLOY — do not move into supabase/migrations/ until the release containing
-- "Every note belongs to an entity" (commit ad028023 and later: the note routes that send
-- vehicle_id) is deployed. Then move it there, renamed to a current timestamp
-- (e.g. 20261101000000_notes_entity_required.sql), and push.
--
-- Why it waits: the release before that one inserts notes without vehicle_id. Pushed earlier, this
-- trigger makes every note creation fail until the new code ships. See CLAUDE.md, "A migration
-- that must wait for a deploy". Depends on 20261007100600_notes_entity.sql (the column).

-- New notes must name an entity, and a note's entity can be changed but not cleared. A trigger
-- rather than a CHECK: Postgres re-checks a NOT VALID check on every UPDATE, so pinning or editing
-- one of the unattributed legacy notes above would fail until someone assigned it.
create or replace function public.company_notes_entity_required()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.vehicle_id is null and (tg_op = 'INSERT' or old.vehicle_id is not null) then
    raise exception 'A note must belong to an entity' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists company_notes_entity_required on public.company_notes;
create trigger company_notes_entity_required
  before insert or update of vehicle_id on public.company_notes
  for each row execute function public.company_notes_entity_required();

