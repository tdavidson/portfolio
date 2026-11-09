-- A cost transfer moves cost basis from one holding to another inside one entity, with no cash and
-- no gain: one journal entry, Dr Investment — target / Cr Investment — source. Before this, the
-- reader adopted that entry as proceeds on the source and an investment in the target, which
-- reported proceeds that were never received.
--
-- One entry owns two rows, both transaction_type 'cost_transfer' and both adopted from it:
--   source: investment_cost = -amount (invested capital and cost go down; nothing is realized)
--   target: investment_cost = +amount (invested capital and cost start on the transfer date)
-- transfer_company_id names the other holding on each row.
--
-- Idempotent: safe to paste twice.

alter table public.investment_transactions
  add column if not exists transfer_company_id uuid references public.companies(id) on delete set null;

alter table public.investment_transactions
  drop constraint if exists investment_transactions_transaction_type_check;

alter table public.investment_transactions
  add constraint investment_transactions_transaction_type_check
  check (transaction_type in (
    'investment', 'proceeds', 'escrow_receipt', 'unrealized_gain_change', 'round_info', 'split', 'income', 'cost_transfer'
  ));

-- A transfer always moves some cost, and is always dated (it is booked by a dated entry).
alter table public.investment_transactions
  drop constraint if exists investment_transactions_cost_transfer_amount_check;

alter table public.investment_transactions
  add constraint investment_transactions_cost_transfer_amount_check
  check (transaction_type <> 'cost_transfer' or (investment_cost is not null and investment_cost <> 0 and transaction_date is not null));

comment on column public.investment_transactions.transfer_company_id is
  'On a cost_transfer row, the other holding: the target on the source row, the source on the target row.';
