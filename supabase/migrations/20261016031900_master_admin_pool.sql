-- Master admin over the agent connector (lib/agent/master-admin.ts).
--
-- A deployment can list email addresses in MASTER_ADMIN_EMAILS. Each listed address is still its
-- own user in its own fund (fund_members.user_id stays unique); what the list adds is that ONE
-- Claude connection, authorized by any listed address, can work in every listed address's fund,
-- one fund at a time, acting there as that fund's listed admin. Nothing here changes the web app.
--
-- Two pieces of state:
--   master_admin_pool(emails)  which of the listed addresses are admins, and of which fund. It
--                              reads auth.users, so it is SECURITY DEFINER and service-role only.
--   agent_active_funds         which pool fund a given connection is working in right now. Read
--                              and written only by the MCP route with the service-role key.

create or replace function public.master_admin_pool(p_emails text[])
returns table (user_id uuid, email text, fund_id uuid, fund_name text)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, lower(u.email)::text, m.fund_id, f.name
    from auth.users u
    join fund_members m on m.user_id = u.id and m.role = 'admin'
    join funds f on f.id = m.fund_id
   where lower(u.email) = any (select lower(e) from unnest(p_emails) e)
   order by f.name
$$;

revoke execute on function public.master_admin_pool(text[]) from public, anon, authenticated;
grant execute on function public.master_admin_pool(text[]) to service_role;

create table public.agent_active_funds (
  -- The user who authorized the connection (the token's owner), and the OAuth client it was for.
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  fund_id uuid not null references funds(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

-- Service role only: the route holding the service-role key is the only reader and writer, so no
-- authenticated grant and no policies. RLS on denies everyone else by default.
-- The explicit revoke matters until 2026-10-30: before then a new table still gets the old default
-- grants to anon and authenticated.
revoke all on public.agent_active_funds from anon, authenticated;
grant select, insert, update, delete on public.agent_active_funds to service_role;
alter table public.agent_active_funds enable row level security;
