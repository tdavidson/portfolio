-- Demo seed: make the demo fund's bank reconciliation reconcile.
--
-- 1. The feed's "Opening balance — statement ending 2025-12-31" rows (demo-seed-2026) are a
--    balance, not a transaction. The reconciliation starts from ledger cash before the feed's first
--    line (lib/accounting/bank.ts openingCashBefore), so counting them as well doubled the opening
--    cash. They are ignored here, as an import would ignore a balance line.
-- 2. Fund I's call #8 receipts (demo-seed-calls-forecast-2026) are booked but were never in the
--    feed, so the statement stopped at September. Their three wires are added, matched to those
--    entries.
--
-- Fund II keeps its unmatched and drafted lines on purpose: they are what the bank screen shows
-- a reviewer working through. demo-seed-bank-rec-2026-remove.sql reverses this file.
begin;

update bank_transactions
   set status = 'ignored', raw = raw || '{"demo_bank_rec":"2026"}'::jsonb
 where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab'
   and dedup_hash = 'demo-opening-2025-12-31'
   and status = 'reconciled';

insert into bank_transactions (fund_id, portfolio_group, vehicle_id, source, dedup_hash, txn_date, amount, description, counterparty, status, journal_entry_id, suggested_account_code, raw)
select 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Fund I', '061ee98b-cea1-465e-a73c-d597df4afaba', 'csv', v.hash, v.d::date, v.amt, v.descr, v.cp, 'reconciled', v.je::uuid, '3100',
       jsonb_build_object('date', v.d, 'amount', v.amt, 'description', v.descr, 'counterparty', v.cp, 'demo_seed', 'bank-rec-2026')
  from (values
    ('demo-call8-founders',  '2026-10-05', 400000.00, 'Capital call #8 — wire from Hemrock Founders Capital LP',   'Hemrock Founders Capital LP',   '61199544-e04f-46af-8408-8377278ec3fb'),
    ('demo-call8-northstar', '2026-10-06', 300000.00, 'Capital call #8 — wire from Northstar Family Office I LLC', 'Northstar Family Office I LLC', '80c63f54-dbca-4b8e-88e6-9fa55f678722'),
    ('demo-call8-coastal',   '2026-10-07', 125000.00, 'Capital call #8 — wire from Coastal University Endowment',  'Coastal University Endowment',  '08aef666-cca8-4094-9550-98db3d2cf8b7')
  ) as v(hash, d, amt, descr, cp, je)
 where not exists (
   select 1 from bank_transactions b
    where b.fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and b.dedup_hash = v.hash
 );

commit;
