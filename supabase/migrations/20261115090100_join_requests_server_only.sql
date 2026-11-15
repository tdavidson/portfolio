-- Join requests are written by the server only, and new tables stop getting TRUNCATE.
--
-- 1. fund_join_requests: /api/onboarding/join checks the fund's signup allow-list and stamps the
--    caller's own sign-in email; /api/settings/members/[id] approves and rejects. Both use the
--    service role. The browser policies let any signed-in account with no fund (an LP portal login,
--    for one) insert a pending request to any fund through the Data API, skipping the allow-list,
--    with any email shown to the admin. Members keep reading their own request (app/pending).
--
-- 2. diligence_rounds was created after 20261101240000 (grant hygiene), so it got the default
--    TRUNCATE, TRIGGER and REFERENCES grants for anon and authenticated back. TRUNCATE ignores RLS.
--    Revoke them, and stop the default privileges handing them to tables created from now on.
--
-- Idempotent: safe to paste twice.

drop policy if exists "Authenticated users can create join requests" on public.fund_join_requests;
drop policy if exists "Fund admins can update join requests" on public.fund_join_requests;
revoke insert, update, delete, truncate, trigger, references on public.fund_join_requests from anon, authenticated;
revoke select on public.fund_join_requests from anon;

revoke truncate, trigger, references on public.diligence_rounds from anon, authenticated;

alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;
