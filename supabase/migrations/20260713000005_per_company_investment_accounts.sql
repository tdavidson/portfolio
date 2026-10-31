-- Per-investment ledger accounts.
--
-- The chart carried ONE `1100 Investments at cost` and ONE `1200 Unrealized
-- appreciation` for the whole vehicle, so a fund holding nineteen companies had a
-- single aggregate line and the Schedule of Investments got every per-company figure
-- from the portfolio tracker. That meant the ledger tie-out only worked at the TOTAL:
-- if one company's cost was overstated and another's understated by the same amount,
-- the total still tied and the SOI reported both wrong under a green "ties" banner.
--
-- Giving each company its own cost and unrealized account — exactly the pattern
-- already used for per-LP capital (`3100-<lpEntityId>`) — makes the tie-out
-- per-company, and lets an individual position be marked, written off, or exited
-- without disturbing the others.
--
-- `scheduleOfInvestments` already SUMS every account with subtype 'investment' /
-- 'unrealized', so the aggregate accounts keep working and the totals are unchanged.

alter table public.chart_of_accounts
  add column if not exists company_id uuid references companies(id) on delete set null;

comment on column public.chart_of_accounts.company_id is
  'Set on per-investment accounts (1100-<companyId> cost, 1200-<companyId> unrealized). Null on the aggregate and all other accounts. Mirrors lp_entity_id for per-LP capital accounts.';

create index if not exists chart_of_accounts_company_idx
  on public.chart_of_accounts (fund_id, vehicle_id, company_id)
  where company_id is not null;
