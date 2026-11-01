-- The active fund of a pooled assistant connection, per conversation (lib/agent/master-admin.ts).
--
-- agent_active_funds held one row per (user, OAuth client). An assistant's connector is one OAuth
-- client for all of a person's conversations, so `use_fund` in one chat moved every other open
-- chat's next write into that fund, with nothing to tell those chats. The MCP route now issues a
-- session id at `initialize` (returned as Mcp-Session-Id, sent back on every later request) and
-- the active fund is keyed on it too. A client that sends no session id keeps the shared row,
-- session_id '' — which is what every existing row becomes.
--
-- Idempotent: safe to paste twice.

alter table public.agent_active_funds
  add column if not exists session_id text not null default '';

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.agent_active_funds'::regclass
       and contype = 'p'
       and pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id, client_id)'
  ) then
    alter table public.agent_active_funds drop constraint agent_active_funds_pkey;
    alter table public.agent_active_funds add constraint agent_active_funds_pkey primary key (user_id, client_id, session_id);
  end if;
end $$;

-- Conversations end without saying so; their rows are small, and a sweep can drop old ones.
create index if not exists agent_active_funds_updated_idx on public.agent_active_funds (updated_at);

-- Still service role only (20261016031900).
revoke all on public.agent_active_funds from anon, authenticated;
grant select, insert, update, delete on public.agent_active_funds to service_role;
