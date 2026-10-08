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
                      where v.fund_id = n.fund_id and (array[v.name] || v.aliases) && n.mentioned_groups)
 where n.vehicle_id is null and n.company_id is null
   and (select count(*) from public.fund_vehicles v
         where v.fund_id = n.fund_id and (array[v.name] || v.aliases) && n.mentioned_groups) = 1;

-- One entity: counted as 100100 and 100400 count it (active, not the management company).
update public.company_notes n
   set vehicle_id = v.id
  from public.fund_vehicles v
 where n.vehicle_id is null and v.fund_id = n.fund_id and v.active and v.kind <> 'manco'
   and (select count(*) from public.fund_vehicles o where o.fund_id = n.fund_id and o.active and o.kind <> 'manco') = 1;

-- New notes must name an entity: enforced by a trigger staged in
-- supabase/pending-deploy/notes_entity_required.sql — the deployed release inserts notes without
-- vehicle_id, so the trigger may only be applied once the release that sends it has shipped.

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

-- The unread-notes badge counts only notes the user may read (the rule above, for p_user_id — the
-- badge is computed by the service role on the user's behalf, so auth.uid() is not theirs here).
create or replace function public.count_unread_notes(p_user_id uuid)
returns bigint
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with m as (select fund_id, (role in ('admin', 'viewer') or all_entities) as unscoped from fund_members where user_id = p_user_id),
       g as (select vehicle_id from fund_member_vehicles where user_id = p_user_id),
       c as (select distinct cv.company_id from company_vehicles cv where cv.vehicle_id in (select vehicle_id from g))
  select count(*)
    from company_notes cn
    join m on m.fund_id = cn.fund_id
   where cn.user_id <> p_user_id
     and (m.unscoped
          or (cn.vehicle_id in (select vehicle_id from g)
              and (cn.company_id is null or cn.company_id in (select company_id from c))))
     and not exists (select 1 from note_reads nr where nr.note_id = cn.id and nr.user_id = p_user_id);
$$;

revoke execute on function public.count_unread_notes(uuid) from public, anon, authenticated;
