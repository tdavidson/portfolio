-- An admin-reported vehicle's administrator can be ANY fund administrator's MCP server the deployment
-- lists (FUND_ADMIN_MCP_SERVERS, lib/mcp-client/servers.ts), not only Carta. admin_provider now holds
-- that server's id, or 'csv' / 'other' for figures given by hand. Which ids exist is deployment
-- configuration, so the database checks only the shape; the app checks the id against its list.
--
-- Additive in effect: every value the earlier check allowed ('carta', 'csv', 'other') still passes.

alter table public.fund_vehicles drop constraint if exists fund_vehicles_admin_provider_check;
alter table public.fund_vehicles add constraint fund_vehicles_admin_provider_check
  check (admin_provider is null or admin_provider ~ '^[a-z0-9][a-z0-9_-]{0,39}$');
