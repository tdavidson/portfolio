-- LP portal security hardening (from the post-build security review).

-- 1. Revocation completeness: an authorized user's access must drop when the
--    PRINCIPAL LP they act for is disabled — not only when their own account is
--    disabled. Re-create the resolver to also require the principal be active.
create or replace function public.get_my_lp_investor_ids()
returns uuid[]
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(array_agg(distinct lp_investor_id), '{}')
  from (
    select l.lp_investor_id
    from lp_account_links l
    join lp_accounts a on a.id = l.lp_account_id
    where a.auth_user_id = auth.uid() and a.status = 'active'
    union
    select au.lp_investor_id
    from lp_authorized_users au
    join lp_accounts a  on a.id  = au.authorized_user_account_id
    join lp_accounts pa on pa.id = au.principal_lp_account_id
    where a.auth_user_id = auth.uid()
      and a.status  = 'active'
      and pa.status = 'active'
  ) t;
$$;

-- 2. SECURITY DEFINER lockdown — Postgres grants EXECUTE to public by default,
--    exposing a direct PostgREST RPC surface. RLS policies that call this run as
--    the function owner, so revoking caller EXECUTE does NOT break them; it only
--    closes the RPC. (Mirrors 20260509000002_memo_agent_jobs_lockdown.sql.)
revoke execute on function public.get_my_lp_investor_ids() from public;
revoke execute on function public.get_my_lp_investor_ids() from anon;
revoke execute on function public.get_my_lp_investor_ids() from authenticated;

-- 3. Share tables: posture is "authenticated = SELECT only; writes via
--    service_role". The original `for all` admin policies are dead for writes
--    (no write grant) but read as write-intent and would become a live Data API
--    write path if a future migration added an INSERT grant. Make them
--    SELECT-only to match the grant and remove the latent trap.
drop policy if exists lp_snapshot_shares_admin on public.lp_snapshot_shares;
create policy lp_snapshot_shares_admin on public.lp_snapshot_shares
  for select to authenticated
  using (fund_id in (select fund_id from fund_members where user_id = auth.uid() and role = 'admin'));

drop policy if exists lp_letter_shares_admin on public.lp_letter_shares;
create policy lp_letter_shares_admin on public.lp_letter_shares
  for select to authenticated
  using (fund_id in (select fund_id from fund_members where user_id = auth.uid() and role = 'admin'));

-- 4. Let GP admins read their fund's delegation rows via the Data API too, so a
--    future user-context read path fails closed correctly rather than silently
--    returning nothing (defense-in-depth; the API uses the admin client today).
create policy lp_authorized_users_admin_read on public.lp_authorized_users
  for select to authenticated
  using (
    lp_investor_id in (
      select i.id from lp_investors i
      join fund_members fm on fm.fund_id = i.fund_id
      where fm.user_id = auth.uid() and fm.role = 'admin'
    )
  );
