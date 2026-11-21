-- Per-holding page settings, set from the holding's edit dialog (the pencil) or update_company.
--
--   metrics_enabled      show the metrics section (charts, or its empty state). On by default, as today.
--   analyst_enabled      show the AI analyst (the summary panel and the header Analyst button). On by default.
--   price_feed_enabled   show the price feed section on a company that has no feed yet, so one can be
--                        added. Off by default: most companies are not market-priced. A holding that
--                        already has a feed always shows it, and a digital asset always does.

alter table public.companies
  add column if not exists metrics_enabled boolean not null default true,
  add column if not exists analyst_enabled boolean not null default true,
  add column if not exists price_feed_enabled boolean not null default false;
