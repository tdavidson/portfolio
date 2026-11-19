-- New public tables stop getting Data API grants by default, and anon loses table writes.
--
-- 1. Default privileges. Tables created by postgres in public still pick up full grants for anon
--    and authenticated (select, insert, update, delete) from the project's default privileges.
--    Every table has RLS on today, so those grants reach no rows, but a future migration that
--    forgot `enable row level security` would hand that table to anyone holding the public anon
--    key. CLAUDE.md already requires every `create table` migration to carry its own grants (fresh
--    Supabase projects create tables without them), so removing the defaults only makes this
--    project behave like a fresh install. TRUNCATE, TRIGGER and REFERENCES were already removed by
--    20261115090100.
--
-- 2. Anon writes on existing tables. About twenty older tables still carry anon insert, update or
--    delete from the defaults. No policy lets anon write any public table, so RLS already refuses
--    those writes; this removes the grants as a second layer. Anon SELECT is left alone: the
--    repo's table template grants it on purpose, and site_content is read by signed-out visitors.
--    A table that ever gains an anon or public write policy is skipped, so a deliberate grant is
--    never taken away by a re-run.
--
-- Changes grants only, no data. Idempotent: safe to paste twice.

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;

do $$
declare
  t text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public'
          and p.tablename = c.relname
          and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
          and p.roles && array['anon', 'public']::name[]
      )
  loop
    execute format('revoke insert, update, delete on public.%I from anon', t);
  end loop;
end
$$;
