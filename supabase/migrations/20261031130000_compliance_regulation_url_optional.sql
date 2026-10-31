-- Not every compliance item has a regulation to link to: the seed's internal items (insurance
-- renewals and the like) have no URL. 20260312100001_compliance.sql now creates the column as
-- nullable so a fresh install's seed runs; this brings databases created before that change into
-- line. Safe to run more than once.
alter table public.compliance_items
  alter column regulation_url drop not null;
