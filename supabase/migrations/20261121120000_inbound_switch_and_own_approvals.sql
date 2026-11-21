-- Two access changes, both mirrored in the app (lib/access, lib/pending-actions/service.ts).
--
-- 1. The Inbound page gets its own fund-level switch, `inbound` (DEFAULT_FEATURE_VISIBILITY in
--    lib/types/features.ts). It defaults to 'everyone', which is what members have today, and an
--    admin can set it to 'admin' ("Admins only") in Settings or with setup_fund over MCP. The
--    mailbox routes (api/emails*), the Inbound pages and the inbox_* tools already check it; this
--    makes the Data API agree, so "Admins only" holds from the browser console too.
--
--    The email-attachments storage policies read inbound_emails as the caller, so they follow.
--
-- 2. Approvals: a member sees only the changes they staged themselves; admins see every one. The
--    service filters the queue the same way; this is the same rule for the Approvals badge (counted
--    with the member's own client) and any direct read.

-- ---- 1a. feature_default() learns `inbound` --------------------------------------------------
-- Restated in full: rls-domain-policies.test.ts compares the last definition with
-- DEFAULT_FEATURE_VISIBILITY.
create or replace function public.feature_default(p_feature text)
returns text
language sql
immutable
parallel safe
as $$
  select case p_feature
    when 'interactions'       then 'off'
    when 'investments'        then 'everyone'
    when 'notes'              then 'off'
    when 'lp_letters'         then 'off'
    when 'imports'            then 'everyone'
    when 'asks'               then 'admin'
    when 'inbound'            then 'everyone'
    when 'lps'                then 'off'
    when 'lp_tracking'        then 'off'
    when 'lp_portal'          then 'off'
    when 'lp_activity'        then 'off'
    when 'compliance'         then 'off'
    when 'deals'              then 'off'
    when 'diligence'          then 'off'
    when 'accounting'         then 'off'
    when 'gp_economics'       then 'off'
    when 'tax_reporting'      then 'off'
    when 'management_company' then 'off'
    -- An unknown key is not a reason to open a door.
    else 'off'
  end;
$$;

-- ---- 1b. inbound_emails: portfolio + inbound ---------------------------------------------------
-- Drop the domain policies on 'inbound_emails' by name. The restrictive "Only the caller's
-- entities" policy (20261007100200) stays as it is.
drop policy if exists "inbound_emails read needs portfolio" on public.inbound_emails;
drop policy if exists "inbound_emails insert needs portfolio write" on public.inbound_emails;
drop policy if exists "inbound_emails update needs portfolio write" on public.inbound_emails;
drop policy if exists "inbound_emails delete needs portfolio write" on public.inbound_emails;

create policy "inbound_emails read needs portfolio"
  on public.inbound_emails for select to authenticated
  using (fund_id = any(public.fund_ids_readable('portfolio', 'inbound')));
create policy "inbound_emails insert needs portfolio write"
  on public.inbound_emails for insert to authenticated
  with check (fund_id = any(public.fund_ids_writable('portfolio', 'inbound')));
create policy "inbound_emails update needs portfolio write"
  on public.inbound_emails for update to authenticated
  using (fund_id = any(public.fund_ids_writable('portfolio', 'inbound')))
  with check (fund_id = any(public.fund_ids_writable('portfolio', 'inbound')));
create policy "inbound_emails delete needs portfolio write"
  on public.inbound_emails for delete to authenticated
  using (fund_id = any(public.fund_ids_writable('portfolio', 'inbound')));

-- ---- 2. pending_actions: a member reads only their own ------------------------------------------
-- Writes stay service-role only (20261014140000). The read keeps its domain check and adds: staged
-- by the caller, or the caller is the fund's admin.
drop policy if exists "pending_actions read needs read in the row's domain" on public.pending_actions;
create policy "pending_actions read needs read in the row's domain"
  on public.pending_actions for select to authenticated
  using (
    public.can_read_domain(fund_id, domain)
    and (created_by = auth.uid() or public.is_fund_admin(fund_id))
  );
