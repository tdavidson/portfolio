-- Two Data API holes, both reachable from the browser console with the anon key and a session.
--
-- 1. diligence-documents / diligence-recordings storage policies (20260902174637) test
--    `exists (select 1 from public.diligence_deals d where d.id = (storage.foldername(name))[1]::uuid …)`.
--    Inside that subquery the bare `name` binds to diligence_deals.name, not storage.objects.name, so
--    the check never looks at the object's path: a member with diligence write in ANY fund who names
--    one of their deals "<its own id>/x" could list, read, overwrite and delete every fund's diligence
--    files. Recreated here with the column qualified, as the email-attachments policies already are.
--
-- 2. public.funds kept its original 20260227000008 write policies: any member (a viewer included)
--    could UPDATE their fund row (no role check), set created_by to themselves and then DELETE it;
--    and any signed-in account, LP-portal users included, could INSERT a fund and be made its admin
--    by trigger. Every app write to funds uses the service role (lib/onboarding/create-fund.ts,
--    app/api/settings, app/api/onboarding/fund, lib/onboarding/setup-plan.ts), so the browser keeps
--    SELECT only.
--
-- Neither change depends on new application code, so this is safe to push before the deploy.

-- ── 1. Diligence buckets ─────────────────────────────────────────────────────────────────────────
drop policy if exists "diligence-documents read needs diligence" on storage.objects;
drop policy if exists "diligence-documents write needs diligence write" on storage.objects;
drop policy if exists "diligence-documents update needs diligence write" on storage.objects;
drop policy if exists "diligence-documents delete needs diligence write" on storage.objects;
drop policy if exists "diligence-recordings read needs diligence" on storage.objects;
drop policy if exists "diligence-recordings write needs diligence write" on storage.objects;
drop policy if exists "diligence-recordings delete needs diligence write" on storage.objects;

create policy "diligence-documents read needs diligence"
  on storage.objects for select to authenticated
  using (bucket_id = 'diligence-documents' and exists (
    select 1 from public.diligence_deals d
     where d.id = (storage.foldername(objects.name))[1]::uuid
       and d.fund_id = any(public.fund_ids_readable('diligence'))));
create policy "diligence-documents write needs diligence write"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'diligence-documents' and exists (
    select 1 from public.diligence_deals d
     where d.id = (storage.foldername(objects.name))[1]::uuid
       and d.fund_id = any(public.fund_ids_writable('diligence'))));
create policy "diligence-documents update needs diligence write"
  on storage.objects for update to authenticated
  using (bucket_id = 'diligence-documents' and exists (
    select 1 from public.diligence_deals d
     where d.id = (storage.foldername(objects.name))[1]::uuid
       and d.fund_id = any(public.fund_ids_writable('diligence'))))
  with check (bucket_id = 'diligence-documents' and exists (
    select 1 from public.diligence_deals d
     where d.id = (storage.foldername(objects.name))[1]::uuid
       and d.fund_id = any(public.fund_ids_writable('diligence'))));
create policy "diligence-documents delete needs diligence write"
  on storage.objects for delete to authenticated
  using (bucket_id = 'diligence-documents' and exists (
    select 1 from public.diligence_deals d
     where d.id = (storage.foldername(objects.name))[1]::uuid
       and d.fund_id = any(public.fund_ids_writable('diligence'))));

create policy "diligence-recordings read needs diligence"
  on storage.objects for select to authenticated
  using (bucket_id = 'diligence-recordings' and exists (
    select 1 from public.diligence_deals d
     where d.id = (storage.foldername(objects.name))[1]::uuid
       and d.fund_id = any(public.fund_ids_readable('diligence'))));
create policy "diligence-recordings write needs diligence write"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'diligence-recordings' and exists (
    select 1 from public.diligence_deals d
     where d.id = (storage.foldername(objects.name))[1]::uuid
       and d.fund_id = any(public.fund_ids_writable('diligence'))));
create policy "diligence-recordings delete needs diligence write"
  on storage.objects for delete to authenticated
  using (bucket_id = 'diligence-recordings' and exists (
    select 1 from public.diligence_deals d
     where d.id = (storage.foldername(objects.name))[1]::uuid
       and d.fund_id = any(public.fund_ids_writable('diligence'))));

-- ── 2. funds: read-only from the browser ────────────────────────────────────────────────────────
drop policy if exists "Authenticated users can create a fund" on public.funds;
drop policy if exists "Fund members can update their fund" on public.funds;
drop policy if exists "Fund creator can delete their fund" on public.funds;
revoke insert, update, delete on public.funds from anon, authenticated;
