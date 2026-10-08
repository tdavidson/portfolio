-- Entity-level access: which of the fund's entities (fund_vehicles) a member may see.
--
-- Until now access was per tenant and per domain: anyone with `portfolio` read saw every entity's
-- holdings, anyone with `accounting` every entity's books. One platform hosts entities managed by
-- different people, so a member is now granted ENTITIES as well as domains, and sees only those.
--
-- Admins see every entity without grants. A non-admin sees what is granted here — or everything,
-- when they hold the explicit "All entities" grant (fund_members.all_entities), which also covers
-- entities created later. Every member who exists when this runs gets "All entities", so nobody
-- loses access on deploy; admins narrow from there. See plans/spec-entity-access-and-portfolio.md.

-- ---------------------------------------------------------------------------
-- 1. The grants. Created and backfilled ONCE: a re-run must not restore grants an admin removed.
--    "All entities" is an explicit grant, not "holds every row that happens to exist": inferring it
--    made creating any new entity silently narrow every such member.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.fund_member_vehicles') is null then
    create table public.fund_member_vehicles (
      fund_id    uuid not null references funds(id) on delete cascade,
      user_id    uuid not null references auth.users(id) on delete cascade,
      vehicle_id uuid not null references fund_vehicles(id) on delete cascade,
      -- Provenance, not a dependency: removing the granting admin must not remove the grant.
      granted_by uuid references auth.users(id) on delete set null,
      created_at timestamptz not null default now(),
      primary key (fund_id, user_id, vehicle_id)
    );

    alter table public.fund_members add column if not exists all_entities boolean not null default false;
    -- Everyone who is a member when this is pushed keeps seeing everything.
    update public.fund_members set all_entities = true;
  end if;
end $$;

-- New members default to no entities: an admin chooses theirs on approval.
alter table public.fund_members add column if not exists all_entities boolean not null default false;

create index if not exists fund_member_vehicles_vehicle_idx on public.fund_member_vehicles (vehicle_id);

-- Grants: written only by the settings API with the service role (as fund_member_access is). A
-- member may read their own rows; nothing is written through the Data API.
grant select on public.fund_member_vehicles to authenticated;
grant select, insert, update, delete on public.fund_member_vehicles to service_role;

alter table public.fund_member_vehicles enable row level security;

drop policy if exists "Members read their own entity grants" on public.fund_member_vehicles;
create policy "Members read their own entity grants"
  on public.fund_member_vehicles for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. The caller's visible entities, for RLS. Admin: every vehicle in their fund. Otherwise: granted.
-- ---------------------------------------------------------------------------
create or replace function public.vehicle_ids_readable()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(v.id), '{}'::uuid[])
    from fund_members m
    join fund_vehicles v on v.fund_id = m.fund_id
   where m.user_id = auth.uid()
     and (m.role = 'admin' or m.all_entities
          or exists (select 1 from fund_member_vehicles g
                      where g.fund_id = m.fund_id and g.user_id = m.user_id and g.vehicle_id = v.id));
$$;

revoke execute on function public.vehicle_ids_readable() from public, anon;
grant execute on function public.vehicle_ids_readable() to authenticated, service_role;

comment on function public.vehicle_ids_readable() is
  'The fund_vehicles ids the signed-in user may see: all of their fund''s for an admin, granted ones otherwise. For RLS predicates. See lib/access/scope.ts.';

-- ---------------------------------------------------------------------------
-- 3. access_context gains `vehicles`. Everything it returned before is unchanged, so a release
--    deployed before this migration keeps working; lib/access/effective.ts treats a missing
--    `vehicles` key as "all", the behaviour before entity access existed.
-- ---------------------------------------------------------------------------
create or replace function public.access_context(p_user_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_target uuid;
  v_result jsonb;
begin
  -- Own context always; someone else's only for the service role (no JWT identity). See
  -- 20260716000009_access_context_rpc.sql.
  v_target := coalesce(p_user_id, auth.uid());
  if auth.uid() is not null and v_target <> auth.uid() then
    raise exception 'access_context: you may only resolve your own access';
  end if;
  if v_target is null then
    return null;
  end if;

  select jsonb_build_object(
    'fund_id', m.fund_id,
    'role', m.role,
    'features', coalesce(fs.feature_visibility, '{}'::jsonb),
    'grants', coalesce(
      (select jsonb_object_agg(a.domain, a.level)
         from fund_member_access a
        where a.fund_id = m.fund_id and a.user_id = m.user_id),
      '{}'::jsonb),
    'defaults', coalesce(
      (select jsonb_object_agg(d.domain, d.level)
         from fund_domain_defaults d
        where d.fund_id = m.fund_id),
      '{}'::jsonb),
    'vehicles', coalesce(
      (select jsonb_agg(v.id order by v.id)
         from fund_vehicles v
        where v.fund_id = m.fund_id
          and (m.role = 'admin' or m.all_entities
               or exists (select 1 from fund_member_vehicles g
                           where g.fund_id = m.fund_id and g.user_id = m.user_id and g.vehicle_id = v.id))),
      '[]'::jsonb),
    -- Unscoped: an admin, or a member holding the "All entities" grant. Such a member sees what an
    -- admin sees — unassigned companies, rows with no entity, and entities created later.
    'vehicles_all', m.role = 'admin' or m.all_entities
  )
  into v_result
  from fund_members m
  left join fund_settings fs on fs.fund_id = m.fund_id
  where m.user_id = v_target;

  return v_result;
end;
$$;

revoke execute on function public.access_context(uuid) from public, anon;
grant execute on function public.access_context(uuid) to authenticated, service_role;

comment on function public.access_context(uuid) is
  'Resolve a user''s access inputs (fund, role, feature switches, grants, defaults, visible entities) in one call. Own user only, unless called by the service role. See lib/access/effective.ts.';
