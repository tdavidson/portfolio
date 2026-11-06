-- Members' own sign-ins to outside MCP servers (lib/mcp-client/servers.ts), such as a company-data
-- service the diligence assistant can query. One row per member per server.
--
-- Tokens are encrypted with the fund's DEK (lib/credentials/fund-dek.ts). The only readers are
-- server routes holding the service-role key, so the table is granted to service_role alone, with
-- no policies for authenticated: RLS then denies every browser read even if a grant creeps back.

create table if not exists public.mcp_connections (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  fund_id                  uuid not null references funds(id) on delete cascade,
  -- An id from lib/mcp-client/servers.ts, e.g. 'specter'.
  server_id                text not null,
  -- The OAuth client this connection registered (dynamic client registration), and where to
  -- redeem and refresh its tokens.
  client_id                text not null,
  client_secret_encrypted  text,
  token_endpoint           text not null,
  access_token_encrypted   text not null,
  refresh_token_encrypted  text,
  expires_at               timestamptz,
  scope                    text,
  -- The server's read-only tools, the only ones the assistant is allowed to call. Refreshed when
  -- tools_checked_at goes stale.
  read_tools               text[] not null default '{}',
  tools_checked_at         timestamptz,
  last_used_at             timestamptz,
  -- Set when a refresh or call fails, so Settings can ask the member to reconnect.
  last_error               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (user_id, server_id)
);

create index if not exists mcp_connections_fund_id_idx on public.mcp_connections (fund_id);

grant select, insert, update, delete on public.mcp_connections to service_role;

alter table public.mcp_connections enable row level security;
