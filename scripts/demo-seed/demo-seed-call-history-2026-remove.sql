-- Removes demo-seed-call-history-2026: the settlement reviews, lines and calls it registered, Fund II #7's entries
-- (postings cascade), the Fund I commitment increase, and Fund I #8's number.
begin;
delete from capital_settlement_reviews where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and kind = 'call' and line_id in (select id from capital_call_lines where call_id in (select id from capital_calls where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and request_key like 'demo-seed-call-history-2026:%'));
delete from capital_call_lines where call_id in (select id from capital_calls where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and request_key like 'demo-seed-call-history-2026:%');
delete from capital_calls where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and request_key like 'demo-seed-call-history-2026:%';
delete from journal_entries where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and source_ref = 'demo-seed-call-history-2026';
delete from commitment_events where id in ('395c9704-34a1-5d69-967f-2b7c4ffecaca', 'ee40aab0-de74-514b-b514-5b20adb0a2ff', '64e1ecb6-9059-5472-aa9a-85ea0cf28d91', '2d7f7001-280c-543f-92e9-fc060ef86d0b', 'eee1469c-5acc-52c9-8310-12b590832501');
update capital_calls set call_number = null where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and vehicle_id = '061ee98b-cea1-465e-a73c-d597df4afaba' and request_key = 'demo-seed-calls-2026';
commit;
