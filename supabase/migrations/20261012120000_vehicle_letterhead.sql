-- supabase/migrations/20261012120000_vehicle_letterhead.sql
--
-- A letterhead per vehicle: logo, name and address. Until now the only letterhead was the fund's
-- (funds.logo_url / name / address), so every LP-facing PDF carried the firm's, including those for
-- a vehicle with its own brand. Where a vehicle sets a part, it replaces the fund's
-- on that vehicle's statements, notices, receipts and letters, and on an investor report whose
-- vehicles all share it (lib/vehicle-letterhead.ts). The logo is a data:image/ URI, like the fund
-- logo, capped at 200KB by the API.
--
-- Additive, and the readers tolerate its absence (they fall back to the fund's letterhead). No new
-- table, so no grants: fund_vehicles keeps the ones it already has.

alter table public.fund_vehicles add column if not exists logo_url text;
alter table public.fund_vehicles add column if not exists letterhead_name text;
alter table public.fund_vehicles add column if not exists letterhead_address text;
