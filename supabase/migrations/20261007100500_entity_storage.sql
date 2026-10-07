-- Entity access for stored FILES. A member's browser can list and download Storage objects with its
-- own JWT, so the document buckets need the entity rule too — the row tables are scoped (100200,
-- 100300), and a file is the same data.
--
-- One RESTRICTIVE policy on storage.objects, ANDed with the existing per-bucket domain policies
-- (20260902174637). Buckets it does not name pass through untouched.
--
--   company-documents  <fund_id>/<company_id>/…   the company is linked to one of the caller's entities
--   email-attachments  <email_id>/…               the email's company is
--   lp-documents       <fund_id>/…                no entity in the path, so unscoped callers only; the
--                                                 app serves these through server-signed URLs, which
--                                                 apply the LP document rule in code (lp-scope.ts)
--
-- Unscoped callers (admins, members granted every entity) see every file in their funds. LP portal
-- users are not fund members; their own policies decide, as for the LP tables (100300). Paths are
-- compared as TEXT, so a legacy object whose folder is not a uuid cannot break the query.

drop policy if exists "Only the caller's entities" on storage.objects;
create policy "Only the caller's entities"
  on storage.objects as restrictive for all to authenticated
  using (
    bucket_id not in ('company-documents', 'lp-documents', 'email-attachments')
    or not (select public.is_fund_member())
    or (bucket_id in ('company-documents', 'lp-documents')
        and (storage.foldername(name))[1] = any((select public.unscoped_fund_ids())::text[]))
    or (bucket_id = 'company-documents'
        and (storage.foldername(name))[2] = any((select public.company_ids_readable())::text[]))
    or (bucket_id = 'email-attachments'
        and exists (select 1 from public.inbound_emails e
                     where e.id::text = (storage.foldername(name))[1]
                       and (e.fund_id = any((select public.unscoped_fund_ids())::uuid[])
                            or e.company_id = any((select public.company_ids_readable())::uuid[]))))
  )
  with check (
    bucket_id not in ('company-documents', 'lp-documents', 'email-attachments')
    or not (select public.is_fund_member())
    or (bucket_id in ('company-documents', 'lp-documents')
        and (storage.foldername(name))[1] = any((select public.unscoped_fund_ids())::text[]))
    or (bucket_id = 'company-documents'
        and (storage.foldername(name))[2] = any((select public.company_ids_readable())::text[]))
    or (bucket_id = 'email-attachments'
        and exists (select 1 from public.inbound_emails e
                     where e.id::text = (storage.foldername(name))[1]
                       and (e.fund_id = any((select public.unscoped_fund_ids())::uuid[])
                            or e.company_id = any((select public.company_ids_readable())::uuid[]))))
  );
