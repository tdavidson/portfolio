-- Grant and function hygiene, from the Supabase advisors and a sweep of table privileges.
--
-- 1. Excess table privileges. The membership and access tables carried TRUNCATE, TRIGGER and
--    REFERENCES for anon and authenticated (TRUNCATE ignores RLS), and anon held INSERT, UPDATE and
--    DELETE on them. None is used through the Data API. Then every public table loses TRUNCATE,
--    TRIGGER and REFERENCES for anon and authenticated: the service role does all of that.
-- 2. SECURITY DEFINER helpers callable by anon: get_my_fund_ids, is_fund_admin, is_fund_writer
--    (and rls_auto_enable where the project has it). anon has no fund, so they answered nothing,
--    but they need not be callable at all. The six policies that applied them to every role
--    (`to public`) now apply to authenticated only, so an anonymous read finds no policy and no
--    rows instead of calling a function it may no longer execute.
-- 3. A fixed search_path on the functions that had none.
--
-- Leaves btree_gist alone. Idempotent: safe to run twice.

-- 1. -------------------------------------------------------------------------------------------
revoke truncate, trigger, references on public.fund_members, public.fund_member_access, public.fund_member_vehicles from anon, authenticated;
revoke truncate, trigger, references on public.fund_settings, public.pending_actions from authenticated;
revoke insert, update, delete on public.fund_members, public.fund_member_access, public.fund_member_vehicles from anon;

do $$
declare
  t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('revoke truncate, trigger, references on public.%I from anon, authenticated', t.relname);
  end loop;
end $$;

-- 2. -------------------------------------------------------------------------------------------
do $$
declare
  p record;
begin
  for p in select pol.tablename, pol.policyname from pg_policies pol
            where pol.schemaname = 'public'
              and pol.tablename in ('funds', 'fund_members', 'fund_join_requests')
              and pol.roles @> '{public}'
              and (coalesce(pol.qual, '') ~ 'get_my_fund_ids|is_fund_admin|is_fund_writer'
                   or coalesce(pol.with_check, '') ~ 'get_my_fund_ids|is_fund_admin|is_fund_writer')
  loop
    execute format('alter policy %I on public.%I to authenticated', p.policyname, p.tablename);
  end loop;
end $$;

revoke execute on function public.get_my_fund_ids() from public, anon;
revoke execute on function public.is_fund_admin(uuid) from public, anon;
revoke execute on function public.is_fund_writer(uuid) from public, anon;
grant execute on function public.get_my_fund_ids() to authenticated, service_role;
grant execute on function public.is_fund_admin(uuid) to authenticated, service_role;
grant execute on function public.is_fund_writer(uuid) to authenticated, service_role;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- 3. -------------------------------------------------------------------------------------------
-- `extensions` is where Supabase installs pg_trgm and friends; pg_temp last so no temporary object
-- can shadow a real one.
do $$
declare
  f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('set_updated_at', 'assert_entry_period_open', 'assert_posting_period_open',
                                'access_rank', 'feature_default', 'domain_primary_feature',
                                'company_update_chunks_search_trigger', 'sync_posting_book', 'cascade_entry_book',
                                'assert_k1_package_mutable', 'assert_k1_child_mutable', 'assert_tax_year_open_for',
                                'assert_k1_delivery_consented', 'journal_search')
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.sig);
  end loop;
end $$;
