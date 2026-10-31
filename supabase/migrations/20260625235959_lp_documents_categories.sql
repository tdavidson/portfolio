-- LP documents: optional category (for grouping in the portal) and an effective
-- document date (e.g. "as of Mar 31"), distinct from the upload timestamp.
alter table public.lp_documents
  add column if not exists category text,
  add column if not exists doc_date  date;
