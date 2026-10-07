-- Every note belongs to an entity. There are no fund-wide notes: a note is written FOR one of the
-- fund's entities (funds, SPVs), and only people who can see that entity read it. On a company two
-- entities share, Fund I's notes are Fund I's. See lib/notes/entity.ts (the same rule in code).

alter table public.company_notes
  add column if not exists vehicle_id uuid references public.fund_vehicles(id);

create index if not exists company_notes_vehicle_idx on public.company_notes (fund_id, vehicle_id, created_at desc);

-- Backfill, once per note that has none, by the only answer there is:
--   1. a note about a company linked to exactly one entity: that entity;
--   2. a note that names exactly one entity (@Fund I — mentioned_groups): that entity;
--   3. any note in a fund with exactly one entity: that entity.
-- Anything else (a note on a shared company, a general note in a several-entity fund) stays
-- unattributed: visible to unscoped callers only until someone assigns it. Every member is granted
-- every entity when entity access is pushed, so nobody loses a note on deploy.
update public.company_notes n
   set vehicle_id = (select cv.vehicle_id from public.company_vehicles cv where cv.company_id = n.company_id)
 where n.vehicle_id is null and n.company_id is not null
   and (select count(*) from public.company_vehicles cv where cv.company_id = n.company_id) = 1;

update public.company_notes n
   set vehicle_id = (select v.id from public.fund_vehicles v
                      where v.fund_id = n.fund_id and v.name = any(n.mentioned_groups))
 where n.vehicle_id is null and n.company_id is null
   and (select count(*) from public.fund_vehicles v where v.fund_id = n.fund_id and v.name = any(n.mentioned_groups)) = 1;

update public.company_notes n
   set vehicle_id = v.id
  from public.fund_vehicles v
 where n.vehicle_id is null and v.fund_id = n.fund_id and v.kind <> 'manco'
   and (select count(*) from public.fund_vehicles o where o.fund_id = n.fund_id and o.kind <> 'manco') = 1;

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

-- The entity rule in RLS, replacing the company-only rule 20261007100200 gave this table: the
-- note's entity is one of the caller's and, for a note about a company, so is the company.
drop policy if exists "Only the caller's entities" on public.company_notes;
create policy "Only the caller's entities"
  on public.company_notes as restrictive for all to authenticated
  using (
    fund_id = any((select public.unscoped_fund_ids())::uuid[])
    or (vehicle_id = any((select public.vehicle_ids_readable())::uuid[])
        and (company_id is null or company_id = any((select public.company_ids_readable())::uuid[])))
  )
  with check (
    fund_id = any((select public.unscoped_fund_ids())::uuid[])
    or (vehicle_id = any((select public.vehicle_ids_readable())::uuid[])
        and (company_id is null or company_id = any((select public.company_ids_readable())::uuid[])))
  );
