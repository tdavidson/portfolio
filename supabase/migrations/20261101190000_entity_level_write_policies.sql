-- Per-entity levels in the database (fund_member_vehicles.level, 20261101100000).
--
-- An entity grant can cap a member at 'read' or 'propose' in that entity, but every restrictive
-- "Only the caller's entities" policy asked only whether the caller could SEE the entity
-- (vehicle_ids_readable and the helpers built on it). So a member with an area grant of write and
-- Read in one entity could still change that entity's rows straight through the Data API.
--
-- This adds a *_writable twin of each *_readable helper: the same sets, counting only entities
-- the caller may write in (level 'write'; 'propose' counts as read here, as access_rank already
-- has it, because proposals go through the app's own routes). Then, beside each existing
-- "Only the caller's entities" policy, a restrictive INSERT, UPDATE and DELETE policy with the
-- same test over the writable sets. Reads are unchanged. Admins, the read-only demo viewer and
-- members holding "All entities" carry no caps, so nothing changes for them.
--
-- The write policies are built from the read policies as they stand when this runs. A later
-- migration that recreates an entity policy should rerun the block at the bottom.
--
-- Idempotent: safe to paste twice.

-- 1. The writable entity set.
create or replace function public.vehicle_ids_writable()
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
     and (m.role in ('admin', 'viewer') or m.all_entities
          or exists (select 1 from fund_member_vehicles g
                      where g.fund_id = m.fund_id and g.user_id = m.user_id and g.vehicle_id = v.id
                        and coalesce(g.level, 'write') = 'write'));
$$;

-- 2. The helpers built on it: each *_readable body with every *_readable call made *_writable.
do $$
declare
  f text;
  def text;
begin
  foreach f in array array[
    'company_ids', 'diligence_ids', 'group_names', 'lp_entity_ids', 'lp_investor_ids',
    'lp_document_ids', 'lp_letter_ids'
  ] loop
    def := pg_get_functiondef(format('public.%s_readable()', f)::regprocedure);
    def := regexp_replace(def, '([a-z_]+)_readable\(', '\1_writable(', 'g');
    execute def;
  end loop;
end $$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'vehicle_ids', 'company_ids', 'diligence_ids', 'group_names', 'lp_entity_ids', 'lp_investor_ids',
    'lp_document_ids', 'lp_letter_ids'
  ] loop
    execute format('revoke execute on function public.%s_writable() from public, anon', f);
    execute format('grant execute on function public.%s_writable() to authenticated, service_role', f);
  end loop;
end $$;

-- 3. A write twin of every "Only the caller's entities" policy.
do $$
declare
  p record;
  using_w text;
  check_w text;
begin
  for p in
    select schemaname, tablename, qual, with_check
      from pg_policies
     where policyname = 'Only the caller''s entities'
       and permissive = 'RESTRICTIVE'
       and schemaname in ('public', 'storage')
  loop
    using_w := regexp_replace(coalesce(p.qual, p.with_check), '([a-z_]+)_readable\(', '\1_writable(', 'g');
    check_w := regexp_replace(coalesce(p.with_check, p.qual), '([a-z_]+)_readable\(', '\1_writable(', 'g');
    -- Nothing entity-shaped to tighten (a policy over unscoped funds or a parent table only).
    continue when using_w = coalesce(p.qual, p.with_check) and check_w = coalesce(p.with_check, p.qual);

    execute format('drop policy if exists %I on %I.%I', 'Entity level allows inserting', p.schemaname, p.tablename);
    execute format('drop policy if exists %I on %I.%I', 'Entity level allows updating', p.schemaname, p.tablename);
    execute format('drop policy if exists %I on %I.%I', 'Entity level allows deleting', p.schemaname, p.tablename);
    execute format('create policy %I on %I.%I as restrictive for insert to authenticated with check (%s)',
      'Entity level allows inserting', p.schemaname, p.tablename, check_w);
    execute format('create policy %I on %I.%I as restrictive for update to authenticated using (%s) with check (%s)',
      'Entity level allows updating', p.schemaname, p.tablename, using_w, check_w);
    execute format('create policy %I on %I.%I as restrictive for delete to authenticated using (%s)',
      'Entity level allows deleting', p.schemaname, p.tablename, using_w);
  end loop;
end $$;
