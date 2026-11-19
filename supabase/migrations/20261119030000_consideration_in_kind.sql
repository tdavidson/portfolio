-- Consideration settled in securities rather than cash.
--
-- On a `proceeds` row: the part of proceeds_received (the gross) the buyer paid in its own shares
-- (an acquisition paid in stock). On an `investment` row: the part of investment_cost paid with
-- securities received in an exit, rather than cash. The two settle through 1360 (Securities
-- received in exits), so an acquisition paid in stock is a realization at fair value and the new
-- shares carry that value as their cost, with no cash leg.
alter table public.investment_transactions
  add column if not exists consideration_in_kind numeric not null default 0
    check (consideration_in_kind >= 0);
