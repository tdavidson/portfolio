-- pending_actions: the browser may READ (the Approvals nav badge counts with the user's own client,
-- app/(app)/layout.tsx), but never write.
--
-- 20260718000000 granted insert/update/delete to `authenticated`, and the policies from
-- 20260902174637 only check the row's own `domain` column — which the client writes. So a member with
-- read in any one domain could, from the browser console with the anon key, insert a pending action
-- whose `args` run any tool (an LP portal invite, a journal entry) under a harmless `preview`, and the
-- admin who approves it would execute `args` while seeing `preview`. A member with write could edit
-- `args` on a real row after it was previewed, or flip an applied row back to pending.
--
-- Every write already goes through the service role (lib/pending-actions/service.ts,
-- lib/agent/dispatch.ts, lib/ai/analyst-tools.ts), so this changes nothing the app does.
-- The read policy stays as it is. anon never had a policy; drop its grant too.

revoke insert, update, delete on public.pending_actions from authenticated;
revoke select on public.pending_actions from anon;

drop policy if exists "pending_actions staged by anyone who can read the domain" on public.pending_actions;
drop policy if exists "pending_actions approved only with write in the domain" on public.pending_actions;
drop policy if exists "pending_actions delete needs write in the domain" on public.pending_actions;
