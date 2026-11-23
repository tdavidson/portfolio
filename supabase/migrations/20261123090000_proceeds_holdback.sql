-- A holdback kept apart from escrow.
--
-- On a `proceeds` row: the part of proceeds_escrow the buyer owes directly (a holdback note, a
-- deferred tranche) rather than money held in an escrow account. It stays inside proceeds_escrow,
-- so every report reads the same totals; the ledger books it to 1355 (Holdback receivable)
-- instead of 1350. On an `escrow_receipt` row: the part of the cash received that clears 1355.
alter table public.investment_transactions
  add column if not exists proceeds_holdback numeric not null default 0
    check (proceeds_holdback >= 0);
