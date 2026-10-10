-- Removes demo-seed-calls-2026: the forecast plan (its rules, versions and compiled entries cascade), the call
-- and its lines, and every journal entry the seed wrote (postings cascade).
begin;
delete from forecast_plans where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and seed->>'demo_seed' = 'demo-seed-calls-2026';
delete from capital_call_lines where call_id in (select id from capital_calls where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and request_key = 'demo-seed-calls-2026');
delete from capital_calls where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and request_key = 'demo-seed-calls-2026';
delete from journal_entries where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and source_ref = 'demo-seed-calls-2026';
commit;
