-- Saved dashboards can be the capital-call dashboard too (`show_capital_calls`).
--
-- Widening only: every row the old check allowed, this one allows, so it is safe to apply before
-- the release that writes 'calls' — the deployed code simply never asks for it yet.
-- The original check was declared inline on the column, so Postgres named it
-- saved_dashboards_view_check.

alter table public.saved_dashboards drop constraint if exists saved_dashboards_view_check;
alter table public.saved_dashboards
  add constraint saved_dashboards_view_check
  check (view in ('portfolio', 'company', 'statements', 'lps', 'calls'));
