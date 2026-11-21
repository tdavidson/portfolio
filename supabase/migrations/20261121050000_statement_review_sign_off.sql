-- Statement review sign-off (docs/spec/statement-review.md, stage 5): who signed off a period's
-- review, when, and the record of what they signed off (the package's documents and hashes, the
-- counts, the finding statuses and the checks), so the review can be audited later. The next
-- period's continuity check carries on from the latest signed-off review.
--
-- statement_reviews stays service role only (20261121030000_statement_reviews.sql); no grants change.

alter table public.statement_reviews
  add column if not exists signed_off_by uuid references auth.users(id) on delete set null,
  add column if not exists signed_off_at timestamptz,
  add column if not exists sign_off jsonb;

create index if not exists statement_reviews_signed_off_idx
  on public.statement_reviews (fund_id, vehicle_id, period_end desc)
  where signed_off_at is not null;
