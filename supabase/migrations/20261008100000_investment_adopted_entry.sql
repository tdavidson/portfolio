-- supabase/migrations/20261008100000_investment_adopted_entry.sql
--
-- An investment transaction ADOPTED from a journal entry: the entry was booked first (a
-- QuickBooks import, a manual journal entry, the bank categorizer) and posting it read its
-- investment-account lines as the transactions they record. The entry stays exactly as booked;
-- this column is what makes it "owned". See plans/spec-ledger-one-writer.md §1.
--
-- No grants: an existing table, already granted by 20260513000000_data_api_grants_backfill.sql.

alter table public.investment_transactions
  add column if not exists adopted_entry_id uuid references public.journal_entries(id) on delete set null;

create index if not exists investment_transactions_adopted_entry_idx
  on public.investment_transactions (adopted_entry_id)
  where adopted_entry_id is not null;

comment on column public.investment_transactions.adopted_entry_id is
  'The journal entry this transaction was adopted from (ledger → tracker). Null for a transaction whose entry was derived from it (source_ref = txn:<id>).';
