-- An entity's governing documents: LPA, operating agreement, side letters, amendments, other — several
-- per entity. Stored so the Analyst can answer questions about their terms and review the entity's
-- books against them. See plans/spec-entity-documents.md.
--
-- Read and written only by server routes holding the service role, which check that the caller can
-- see the entity (lib/entity-documents). So, per CLAUDE.md, granted to service_role alone with RLS on
-- and no authenticated policies: if a grant ever crept back, RLS would still deny.

create table if not exists public.entity_documents (
  id                uuid primary key default gen_random_uuid(),
  fund_id           uuid not null references funds(id) on delete cascade,
  vehicle_id        uuid not null references fund_vehicles(id) on delete cascade,
  kind              text not null default 'other'
                    check (kind in ('lpa', 'operating_agreement', 'side_letter', 'amendment', 'other')),
  title             text not null,
  effective_date    date,
  file_name         text not null,
  content_type      text,
  size_bytes        bigint,
  content_sha256    text,
  storage_path      text not null,
  page_count        int,
  extracted_text    text,
  extraction_status text not null default 'pending'
                    check (extraction_status in ('pending', 'complete', 'partial', 'failed', 'not_applicable')),
  -- Pages with no text layer are transcribed in the background (cron/entity-documents-ocr).
  ocr_status        text not null default 'none'
                    check (ocr_status in ('none', 'pending', 'complete', 'failed')),
  ocr_attempts      int not null default 0,
  -- { pages: { "<n>": text }, needed: [n…] } while OCR is under way.
  ocr_progress      jsonb,
  warnings          text[] not null default '{}',
  uploaded_by       uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists entity_documents_vehicle_idx on public.entity_documents (fund_id, vehicle_id, created_at desc);
create index if not exists entity_documents_ocr_idx on public.entity_documents (ocr_status) where ocr_status = 'pending';

create table if not exists public.entity_document_chunks (
  id          uuid primary key default gen_random_uuid(),
  fund_id     uuid not null references funds(id) on delete cascade,
  vehicle_id  uuid not null references fund_vehicles(id) on delete cascade,
  document_id uuid not null references entity_documents(id) on delete cascade,
  ordinal     int not null,
  locator     jsonb not null default '{}',
  text        text not null,
  search      tsvector generated always as (to_tsvector('english', text)) stored
);

create index if not exists entity_document_chunks_doc_idx on public.entity_document_chunks (document_id, ordinal);
create index if not exists entity_document_chunks_search_idx on public.entity_document_chunks using gin (search);
create index if not exists entity_document_chunks_vehicle_idx on public.entity_document_chunks (fund_id, vehicle_id);

-- 1. Grants: service role only (see header). Revoked explicitly too: projects created before the
--    2026 Data API change grant new tables to anon/authenticated automatically.
revoke all on public.entity_documents from anon, authenticated;
revoke all on public.entity_document_chunks from anon, authenticated;
grant select, insert, update, delete on public.entity_documents to service_role;
grant select, insert, update, delete on public.entity_document_chunks to service_role;

-- 2. RLS on, and no authenticated policies: denied by default.
alter table public.entity_documents enable row level security;
alter table public.entity_document_chunks enable row level security;

-- The files: private, reached only through server-signed URLs (no storage policies for members).
insert into storage.buckets (id, name, public, file_size_limit)
values ('entity-documents', 'entity-documents', false, 26214400)  -- 25 MB, the extraction limit
on conflict (id) do nothing;

-- Full-text search over the given entities' documents, best passages first. The caller passes the
-- entities the requester can see; service role only.
create or replace function public.entity_document_search(
  p_fund_id uuid,
  p_vehicle_ids uuid[],
  p_query text,
  p_limit int default 8
)
returns table (
  document_id uuid,
  vehicle_id uuid,
  title text,
  kind text,
  ordinal int,
  locator jsonb,
  excerpt text,
  rank real
)
language sql
stable
security definer
set search_path = public
as $$
  with q as (select websearch_to_tsquery('english', coalesce(p_query, '')) as tsq)
  select c.document_id, c.vehicle_id, d.title, d.kind, c.ordinal, c.locator,
         ts_headline('english', c.text, q.tsq, 'MaxFragments=2, MaxWords=60, MinWords=20, StartSel=[[, StopSel=]]') as excerpt,
         ts_rank(c.search, q.tsq) as rank
    from entity_document_chunks c
    join entity_documents d on d.id = c.document_id
    cross join q
   where c.fund_id = p_fund_id
     and c.vehicle_id = any(coalesce(p_vehicle_ids, '{}'::uuid[]))
     and c.search @@ q.tsq
   order by rank desc, d.effective_date desc nulls last, c.ordinal
   limit least(greatest(coalesce(p_limit, 8), 1), 25);
$$;

revoke execute on function public.entity_document_search(uuid, uuid[], text, int) from public, anon, authenticated;
grant execute on function public.entity_document_search(uuid, uuid[], text, int) to service_role;
