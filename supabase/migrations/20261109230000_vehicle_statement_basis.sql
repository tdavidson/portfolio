-- A vehicle's default basis for its partners' capital account statements
-- (lib/accounting/statement-basis.ts). A reporting choice only: the ledger and allocations are the
-- same on every basis. A request that names a basis (the statement page toggle, the share dialog,
-- the lp_statement tools) always wins; this is what an unspecified request gets.
--   fair_value — the books as they stand (the default, and every vehicle's statement until now)
--   cost       — leaves out unrealized appreciation and its FX translation
--   cash_only  — also leaves out realized gains and losses
alter table public.fund_vehicles
  add column if not exists statement_basis text not null default 'fair_value';

alter table public.fund_vehicles
  drop constraint if exists fund_vehicles_statement_basis_check;
alter table public.fund_vehicles
  add constraint fund_vehicles_statement_basis_check
  check (statement_basis in ('fair_value', 'cost', 'cash_only'));
