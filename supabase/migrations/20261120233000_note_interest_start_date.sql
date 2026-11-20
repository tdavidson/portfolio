-- The first day a convertible note earns interest, when that isn't the transaction date.
--
-- A note's terms (or the administrator's books the fund is reconciled to) can start interest on a
-- day other than the one the cash moved: a note dated a few days before the wire, or interest that
-- starts the day after funding. With only `transaction_date` to go on, the close's day count is
-- off by those days for the note's whole life, and the only way to match was a manual entry to
-- 1150 — which the next close reverses, because the accrual is a true-up to the note's terms.
--
-- NULL = interest runs from `transaction_date`, as before. No new table, so no Data API grants.

alter table public.investment_transactions
  add column if not exists interest_start_date date;

comment on column public.investment_transactions.interest_start_date is
  'Convertible notes only: the first day interest accrues. NULL = from transaction_date.';
