-- Fund records: what a person or an assistant files from a working session, kept by the fund.
--
-- An MCP server sees tool calls, not the conversation around them. So when an auditor's assistant
-- works through the journal with them, or the fund admin's assistant reconciles a quarter, the
-- record of what was concluded only exists if someone files it. This is where it goes: a summary,
-- a decision, a memo or a transcript excerpt, filed into one area of the fund (accounting, tax,
-- compliance ...) and, usually, one entity. The fund owns it. It stays when the engagement ends,
-- and engagement_id keeps which outside firm filed it.
--
-- Append-only: there is no update path and no delete path in the app. A correction is a new record.
--
-- Read and written only by lib/records (the /api/records route and the file_to_record,
-- list_records and read_record tools), with the service role. Who may see a record is decided
-- there: read on its area, and the entity in the caller's scope.

create table public.fund_records (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  -- Null is fund-wide: only someone who sees every entity sees it, or may file one.
  vehicle_id uuid references public.fund_vehicles(id) on delete cascade,
  area text not null check (area in (
    'portfolio', 'relationships', 'dealflow', 'diligence', 'accounting', 'management_company',
    'lp_capital', 'gp_economics', 'lp_relations', 'compliance', 'tax'
  )),
  kind text not null default 'summary' check (kind in ('summary', 'decision', 'memo', 'transcript', 'note')),
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 100000),
  -- What the record is about, when it is about one thing: a company, an LP investor, a journal
  -- entry or a deal. Checked to belong to the fund when filed.
  subject_type text check (subject_type in ('company', 'lp_investor', 'journal_entry', 'deal')),
  subject_id uuid,
  source text not null default 'web' check (source in ('web', 'api', 'mcp')),
  filed_by uuid references auth.users(id) on delete set null,
  filed_by_email text,
  engagement_id uuid references public.engagements(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint fund_records_subject_pair check ((subject_type is null) = (subject_id is null))
);

create index fund_records_fund_created_idx on public.fund_records (fund_id, created_at desc);
create index fund_records_vehicle_idx on public.fund_records (vehicle_id);
create index fund_records_subject_idx on public.fund_records (fund_id, subject_type, subject_id);

-- Service role only: the area and entity checks live in lib/records, and a grant knows neither.
revoke all on public.fund_records from anon, authenticated;
grant select, insert on public.fund_records to service_role;

alter table public.fund_records enable row level security;
