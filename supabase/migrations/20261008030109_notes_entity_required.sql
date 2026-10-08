-- New notes must name an entity. Staged in supabase/pending-deploy/ until the release whose note
-- routes send vehicle_id ("Every note belongs to an entity", ad028023) shipped: the release before it
-- inserted notes without one, and this trigger would have refused them. Depends on
-- 20261007100600_notes_entity.sql (the column).

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

