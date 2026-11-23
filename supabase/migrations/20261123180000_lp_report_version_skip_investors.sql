-- The stored LP report (20261120100000_lp_report_cache.sql) is rebuilt whenever the fund's data
-- version moves. Its triggers included lp_investors, but the report never reads that table:
-- investor names, alternate names and groupings are joined on at request time by the routes that
-- serve it. So renaming an investor or giving one an alternate name threw away a good report and
-- made the next LPs page load rebuild every vehicle's capital accounts.
--
-- Drop the three lp_investors triggers. lp_entities keeps its triggers: entity names are part of
-- the stored report.

drop trigger if exists lp_report_version_ins_lp_investors on public.lp_investors;
drop trigger if exists lp_report_version_upd_lp_investors on public.lp_investors;
drop trigger if exists lp_report_version_del_lp_investors on public.lp_investors;
