-- LP portal access is disabled per fund, not for the whole deployment. lp_accounts.status was the
-- only switch, so a fund admin disabling "their" LP cut that person's portal in every other fund
-- they invest in. Now an admin disables this fund's links (lp_account_links.disabled_at): the LP,
-- and anyone they authorized, loses this fund's investors and stops getting this fund's emails,
-- and keeps every other fund. lib/lps/portal-access.ts setPortalAccountStatus.
--
-- lp_accounts.status = 'disabled' still means disabled everywhere; nothing sets it from now on
-- except the code before this migration.
--
-- Idempotent: safe to run twice.

alter table public.lp_account_links
  add column if not exists disabled_at timestamptz;

-- The RLS helper for every portal table: the same as 20260625000003, less disabled links, and less
-- delegations whose principal is disabled in that investor's fund.
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
      and l.disabled_at is null
    union
    select au.lp_investor_id
    from lp_authorized_users au
    join lp_accounts a  on a.id  = au.authorized_user_account_id
    join lp_accounts pa on pa.id = au.principal_lp_account_id
    where a.auth_user_id = auth.uid()
      and a.status  = 'active'
      and pa.status = 'active'
      and not exists (
        select 1 from lp_account_links pl
         where pl.lp_account_id = pa.id
           and pl.lp_investor_id = au.lp_investor_id
           and pl.disabled_at is not null
      )
  ) t;
$$;

revoke execute on function public.get_my_lp_investor_ids() from public;
revoke execute on function public.get_my_lp_investor_ids() from anon;
revoke execute on function public.get_my_lp_investor_ids() from authenticated;
