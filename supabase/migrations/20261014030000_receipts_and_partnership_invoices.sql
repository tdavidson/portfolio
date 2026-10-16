-- Receipts, and the quarterly invoice that bills partnership expenses to the fund that owes them.
--
-- THE PROBLEM. The management company (or a GP entity) pays a fund's expenses: a filing fee, the
-- audit, legal on a closing. Each one is a card charge or a bank debit on the payer's books, and at
-- quarter end the payer bills the fund for all of them. Two things were missing:
--
--   1. The receipt. Nothing in the ledger could hold the document behind an entry, so the evidence
--      for every charge lived in someone's inbox. A receipt is now a stored file, ideally emailed
--      straight to the inbound address, that is ATTACHED to the entry it supports: the entry the
--      bank feed drafted, an entry someone typed, or a draft made from the receipt itself. A receipt
--      never posts anything on its own. It is evidence, and the ledger entry is the fact.
--
--   2. The quarterly bill. The payer books a fund's expense the way it is really booked: not as
--      its own expense but as a receivable, Dr "Due from <fund>" (1900-<fund>), Cr cash. At
--      quarter end an invoice gathers every posted debit to that account in the quarter that is
--      not already on an invoice, and issuing it books the fund's side (Dr partnership expenses,
--      Cr Due to <payer>) as an intercompany charge whose receivable is already on the payer's
--      books. The fund's payment is that charge's settlement, and it clears the receivable.
--
-- All three tables are read and written only by server routes holding the service role, which resolve
-- the vehicle through resolveGroupOr400 (so a manco's receipts need the management-company grant,
-- like its ledger). So, per CLAUDE.md, granted to service_role alone with RLS on and no
-- authenticated policies.

-- ============================================================================================
-- 1. Partnership invoices.
-- ============================================================================================

create table if not exists public.partnership_invoices (
  id                          uuid primary key default gen_random_uuid(),
  fund_id                     uuid not null references funds(id) on delete cascade,
  -- WHO BILLS WHOM. `from` paid the expenses and is owed (usually the management company); `to` is
  -- the fund the expenses belong to.
  from_vehicle_id             uuid not null references fund_vehicles(id) on delete cascade,
  to_vehicle_id               uuid not null references fund_vehicles(id) on delete cascade,
  period_start                date not null,
  period_end                  date not null,
  invoice_number              text not null,
  invoice_date                date not null,
  -- Frozen at creation from the lines. An invoice is a demand for money: the number the fund was
  -- sent stays the number on it, whatever happens to the entries afterwards.
  amount                      numeric(20, 2) not null check (amount > 0),
  currency                    text not null default 'USD',
  memo                        text,
  status                      text not null default 'draft' check (status in ('draft', 'issued', 'void')),
  -- The intercompany charge that books the fund's side once issued. Its payee entry is empty: the
  -- receivable was booked line by line as the payer paid.
  intercompany_transaction_id uuid references intercompany_transactions(id) on delete set null,
  created_by                  uuid references auth.users(id) on delete set null,
  created_at                  timestamptz not null default now(),
  issued_at                   timestamptz,
  updated_at                  timestamptz not null default now(),
  constraint partnership_invoice_distinct_vehicles check (from_vehicle_id <> to_vehicle_id),
  constraint partnership_invoice_period check (period_end >= period_start)
);

-- One live invoice per biller, fund and period. A second one would bill the same quarter twice.
create unique index if not exists partnership_invoices_period_idx
  on public.partnership_invoices (fund_id, from_vehicle_id, to_vehicle_id, period_start, period_end)
  where status <> 'void';
create unique index if not exists partnership_invoices_number_idx
  on public.partnership_invoices (fund_id, invoice_number)
  where status <> 'void';
create index if not exists partnership_invoices_from_idx
  on public.partnership_invoices (fund_id, from_vehicle_id, period_end desc);

revoke all on public.partnership_invoices from anon, authenticated;
grant select, insert, update, delete on public.partnership_invoices to service_role;
alter table public.partnership_invoices enable row level security;

-- ============================================================================================
-- 2. The lines of an invoice: which "Due from <fund>" postings it bills.
-- ============================================================================================

-- A link table rather than a column on journal_postings, for two reasons. The period lock
-- (assert_posting_period_open) refuses ANY update to a posting in a closed period, and a quarter
-- is normally closed before it is billed. And a posting can be billed, voided off the invoice and
-- billed again, which a single column cannot remember.
create table if not exists public.partnership_invoice_lines (
  id                  uuid primary key default gen_random_uuid(),
  fund_id             uuid not null references funds(id) on delete cascade,
  invoice_id          uuid not null references public.partnership_invoices(id) on delete cascade,
  journal_entry_id    uuid not null references journal_entries(id) on delete cascade,
  journal_posting_id  uuid not null references journal_postings(id) on delete cascade,
  -- Frozen with the invoice; issuing checks the posting still says the same.
  amount              numeric(20, 2) not null check (amount > 0),
  -- False once the invoice is voided, which releases the posting for the next invoice.
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);

-- A posting is on at most one live invoice. The claim is this index, so two people creating the
-- same quarter's invoice at once cannot both bill it.
create unique index if not exists partnership_invoice_lines_posting_idx
  on public.partnership_invoice_lines (journal_posting_id) where active;
create index if not exists partnership_invoice_lines_invoice_idx
  on public.partnership_invoice_lines (invoice_id);

revoke all on public.partnership_invoice_lines from anon, authenticated;
grant select, insert, update, delete on public.partnership_invoice_lines to service_role;
alter table public.partnership_invoice_lines enable row level security;

-- ============================================================================================
-- 3. Receipts.
-- ============================================================================================

create table if not exists public.receipts (
  id                  uuid primary key default gen_random_uuid(),
  fund_id             uuid not null references funds(id) on delete cascade,
  -- The entity that paid. Null until someone (or the inbound mailbox's default) assigns one: a
  -- receipt forwarded from a phone says nothing about which books it belongs on.
  vehicle_id          uuid references fund_vehicles(id) on delete set null,
  source              text not null default 'upload' check (source in ('email', 'upload', 'agent')),
  source_email_id     uuid references inbound_emails(id) on delete set null,
  file_name           text not null,
  content_type        text,
  size_bytes          bigint,
  storage_path        text not null,
  -- What the receipt says, read by the fund's AI key or the person's own assistant over MCP.
  vendor_name         text,
  receipt_date        date,
  amount              numeric(20, 2),
  currency            text,
  description         text,
  extraction_status   text not null default 'pending'
                      check (extraction_status in ('pending', 'complete', 'failed', 'not_applicable')),
  extraction_notes    text,
  -- matched = attached to an entry, or to a bank transaction that has not been drafted yet (it
  -- follows the transaction onto the entry the transaction becomes).
  status              text not null default 'unmatched' check (status in ('unmatched', 'matched', 'dismissed')),
  journal_entry_id    uuid references journal_entries(id) on delete set null,
  bank_transaction_id uuid references bank_transactions(id) on delete set null,
  matched_at          timestamptz,
  matched_by          uuid references auth.users(id) on delete set null,
  uploaded_by         uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists receipts_fund_idx on public.receipts (fund_id, status, created_at desc);
create index if not exists receipts_vehicle_idx on public.receipts (fund_id, vehicle_id, created_at desc);
create index if not exists receipts_entry_idx on public.receipts (journal_entry_id) where journal_entry_id is not null;
create index if not exists receipts_bank_idx on public.receipts (bank_transaction_id) where bank_transaction_id is not null;

revoke all on public.receipts from anon, authenticated;
grant select, insert, update, delete on public.receipts to service_role;
alter table public.receipts enable row level security;

-- The files: private, reached only through server-signed URLs.
insert into storage.buckets (id, name, public, file_size_limit)
values ('receipts', 'receipts', false, 15728640)  -- 15 MB
on conflict (id) do nothing;

-- ============================================================================================
-- 4. The inbound mailbox learns the destination.
-- ============================================================================================

alter table inbound_emails
  drop constraint if exists inbound_emails_routed_to_check;
alter table inbound_emails
  add constraint inbound_emails_routed_to_check
  check (routed_to is null or routed_to in (
    'reporting', 'interactions', 'deals', 'diligence', 'audit', 'review', 'receipts'
  ));
