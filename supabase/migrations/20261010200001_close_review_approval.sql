-- A close is PREPARED by one person and APPROVED by another.
--
-- Until now the close wrote its review as already approved, with the closer as both preparer and
-- approver. A review now starts 'prepared'; approving it is a separate step that records the
-- approver (lib/accounting/close-approval.ts). Reviews already on record stay 'approved'.
--
-- Widening only: safe to apply before or after the release that writes 'prepared'.
alter table public.close_reviews drop constraint if exists close_reviews_status_check;
alter table public.close_reviews
  add constraint close_reviews_status_check check (status in ('prepared', 'approved', 'reopened'));
