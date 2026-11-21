-- Holding documents: hashes for duplicate checks, and the facts an assistant needs to list them.
--
-- `list_company_documents` and `add_company_document` (lib/companies/holding-documents.ts,
-- lib/companies/document-hashes.ts) compare a new file with what a holding already has, by the
-- SHA-256 of its bytes and by a hash of its normalised extracted text, so a renamed copy or a
-- re-exported PDF still matches.
--
-- Everything here is additive and cheap to apply: nullable columns and one constant default
-- (metadata-only since PostgreSQL 11, no table rewrite), a check constraint added NOT VALID (no
-- scan), and partial indexes over rows that are mostly empty. The hashes for EXISTING rows are not
-- computed here: the document-hashes worker (app/api/cron/document-hashes) fills them in small
-- batches, because the file hash needs the stored bytes and doing it in one statement would load
-- the database at once.

-- 1. Uploaded documents (a holding's Documents page).
alter table public.company_documents
  add column if not exists sha256 text,
  add column if not exists text_sha256 text,
  add column if not exists page_count int,
  add column if not exists hashed_at timestamptz,
  add column if not exists uploaded_via text,
  add column if not exists scan_status text not null default 'clean';

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.company_documents'::regclass
       and conname = 'company_documents_scan_status_check'
  ) then
    alter table public.company_documents
      add constraint company_documents_scan_status_check
      check (scan_status in ('clean', 'pending', 'removed')) not valid;
  end if;
end $$;

comment on column public.company_documents.sha256 is
  'SHA-256 of the stored file bytes (hex). Null when only the text was kept or the file was removed by the virus scan.';
comment on column public.company_documents.text_sha256 is
  'SHA-256 of the normalised extracted text (lib/companies/document-fingerprint.ts). Null when the file yields no text.';
comment on column public.company_documents.hashed_at is
  'When sha256/text_sha256 were computed. Null = not yet (the document-hashes worker fills it).';
comment on column public.company_documents.uploaded_via is
  'web, mcp or api. Null for documents uploaded before this column existed.';
comment on column public.company_documents.scan_status is
  'clean, or removed when the virus scan deleted the file (the row records that it was tried).';

create index if not exists company_documents_company_created_idx
  on public.company_documents (company_id, created_at desc);
create index if not exists company_documents_sha256_idx
  on public.company_documents (company_id, sha256) where sha256 is not null;
create index if not exists company_documents_text_sha256_idx
  on public.company_documents (company_id, text_sha256) where text_sha256 is not null;
create index if not exists company_documents_unhashed_idx
  on public.company_documents (created_at) where hashed_at is null;

-- 2. Files attached to company updates. content_sha256 already holds the byte hash.
alter table public.company_update_artifacts
  add column if not exists text_sha256 text,
  add column if not exists hashed_at timestamptz;

comment on column public.company_update_artifacts.text_sha256 is
  'SHA-256 of the normalised extracted text (lib/companies/document-fingerprint.ts). Null when no text was read.';
comment on column public.company_update_artifacts.hashed_at is
  'When text_sha256 was computed from the current extracted_text. Cleared when extracted_text changes (OCR).';

create index if not exists company_update_artifacts_sha256_idx
  on public.company_update_artifacts (company_id, content_sha256) where content_sha256 is not null;
create index if not exists company_update_artifacts_text_sha256_idx
  on public.company_update_artifacts (company_id, text_sha256) where text_sha256 is not null;
create index if not exists company_update_artifacts_unhashed_idx
  on public.company_update_artifacts (created_at) where hashed_at is null;

-- 3. An artifact's text changes after capture (OCR fills in image pages). Its text hash is then
--    stale, so clear hashed_at and the worker hashes it again. Only on a real change of text.
create or replace function public.company_update_artifacts_text_changed()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.extracted_text is distinct from old.extracted_text then
    new.text_sha256 := null;
    new.hashed_at := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.company_update_artifacts_text_changed() from anon, authenticated, public;

drop trigger if exists company_update_artifacts_text_changed on public.company_update_artifacts;
create trigger company_update_artifacts_text_changed
  before update of extracted_text on public.company_update_artifacts
  for each row execute function public.company_update_artifacts_text_changed();
