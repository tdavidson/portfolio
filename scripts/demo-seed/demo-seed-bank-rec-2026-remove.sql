-- Reverses demo-seed-bank-rec-2026.sql: removes the three call #8 wires and counts the opening
-- balance rows as transactions again.
begin;
delete from bank_transactions
 where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and raw->>'demo_seed' = 'bank-rec-2026';
update bank_transactions
   set status = 'reconciled', raw = raw - 'demo_bank_rec'
 where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and raw->>'demo_bank_rec' = '2026';
commit;
