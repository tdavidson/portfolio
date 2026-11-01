-- Engagements, and a level per entity.
--
-- 1. `fund_member_vehicles.level`: how far a member may go in ONE entity. Until now a granted entity
--    meant "whatever your area grants allow, here". A fund administrator who keeps Fund I's books
--    and only reads Fund II's needs the two to differ, so each entity grant now carries a cap:
--    'write' (the default, and what every existing grant becomes, so nothing changes), 'propose'
--    or 'read'. The effective level in an entity is the lower of the area grant and this cap
--    (lib/access/effective.ts entityAccess). A cap only lowers; it never widens an area grant.
--    Members holding "All entities" and admins have no per-entity rows, so no caps.
--
-- 2. `engagements`: an outside firm the fund has brought in (a fund administrator, a tax preparer,
--    an auditor, a compliance vendor), for a period. Each of the firm's people is an ordinary
--    member of the fund with `fund_members.engagement_id` pointing at it, so every existing gate
--    applies to them unchanged. The engagement adds three things: it groups them, so the fund can
--    see who belongs to which firm; its end date becomes their access end date
--    (`access_expires_at`, 20261012160000); and ending it ends all of their access at once.
--    Admins are never part of an engagement (they never expire).
--
-- Additive and safe to apply before the release that uses it. `access_context` gains one key the
-- current release ignores.

-- ---------------------------------------------------------------------------
-- 1. Per-entity levels
-- ---------------------------------------------------------------------------
alter table public.fund_member_vehicles
  add column if not exists level text not null default 'write';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.fund_member_vehicles'::regclass and conname = 'fund_member_vehicles_level_check'
  ) then
    alter table public.fund_member_vehicles
      add constraint fund_member_vehicles_level_check check (level in ('read', 'propose', 'write'));
  end if;
end $$;

comment on column public.fund_member_vehicles.level is
  'The most this member may do in this entity: write (default), propose or read. Caps the area '
  'grants; never widens them.';

-- ---------------------------------------------------------------------------
-- 2. Engagements
-- ---------------------------------------------------------------------------
create table if not exists public.engagements (
  id          uuid primary key default gen_random_uuid(),
  fund_id     uuid not null references funds(id) on delete cascade,
  -- The firm, as the fund refers to it.
  name        text not null check (length(trim(name)) > 0),
  kind        text not null check (kind in ('fund_admin', 'tax', 'audit', 'compliance', 'other')),
  starts_on   date,
  -- Last day of access. Members assigned to the engagement get it as their access end date.
  ends_on     date,
  -- Set when an admin ends the engagement; every member's access ended at that moment.
  ended_at    timestamptz,
  notes       text,
  -- Everyone ever assigned, kept after they leave or their membership is removed, so the
  -- engagement's activity log still covers them once the engagement is over.
  member_history uuid[] not null default '{}',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists engagements_fund_idx on public.engagements (fund_id, created_at desc);

alter table public.fund_members
  add column if not exists engagement_id uuid references public.engagements(id) on delete set null;

create index if not exists fund_members_engagement_idx
  on public.fund_members (engagement_id) where engagement_id is not null;

comment on column public.fund_members.engagement_id is
  'The outside firm (engagements) this member works for, if any. Never set on an admin.';

-- Read and written only by the admin settings API with the service role, like the other access
-- tables. Nothing reaches it through the Data API, and RLS with no policies denies every row if a
-- grant ever creeps back.
revoke all on public.engagements from anon, authenticated;
grant select, insert, update, delete on public.engagements to service_role;
alter table public.engagements enable row level security;

-- ---------------------------------------------------------------------------
-- 3. access_context returns the per-entity caps
-- ---------------------------------------------------------------------------
-- Restated in full from 20261012160000_member_access_expiry.sql; the only change is the new
-- `vehicle_levels` key: { vehicle_id: level } for the caller's entity grants below write. Empty for
-- admins, the demo viewer and "All entities" members, who have no caps.
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
          and (m.role in ('admin', 'viewer') or m.all_entities
               or exists (select 1 from fund_member_vehicles g
                           where g.fund_id = m.fund_id and g.user_id = m.user_id and g.vehicle_id = v.id))),
      '[]'::jsonb),
    -- Unscoped: an admin, the read-only demo viewer, or a member holding the "All entities" grant.
    -- They see everything — unassigned companies, rows with no entity, and entities created later.
    'vehicles_all', m.role in ('admin', 'viewer') or m.all_entities,
    'vehicle_levels', case
      when m.role in ('admin', 'viewer') or m.all_entities then '{}'::jsonb
      else coalesce(
        (select jsonb_object_agg(g.vehicle_id, g.level)
           from fund_member_vehicles g
          where g.fund_id = m.fund_id and g.user_id = m.user_id and g.level <> 'write'),
        '{}'::jsonb)
    end
  )
  into v_result
  from fund_members m
  left join fund_settings fs on fs.fund_id = m.fund_id
  where m.user_id = v_target
    -- Expired access resolves to no fund at all. Admins never expire.
    and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now());

  return v_result;
end;
$$;

revoke execute on function public.access_context(uuid) from public, anon;
grant execute on function public.access_context(uuid) to authenticated, service_role;
