-- Memo draft provenance and review: who wrote each draft (the memo agent, an assistant connected over
-- MCP from the memo brief, a partner's Word re-import, or a partner), which version of the
-- investment-memo skill it followed, what it cited (a snapshot of the cited brief items), and the
-- review's flags (uncited paragraphs, figures not in the sources, a recommendation outside the
-- partners' section, and so on), shown in the memo editor.
--
-- Additive: existing drafts read as written by the memo agent with no flags. The table's existing
-- grants and RLS policies cover the new columns.

alter table public.diligence_memo_drafts
  add column if not exists written_by     text not null default 'memo_agent',
  add column if not exists skill_version  text,
  add column if not exists brief_snapshot jsonb,
  add column if not exists review_flags   jsonb not null default '[]'::jsonb;

alter table public.diligence_memo_drafts
  drop constraint if exists diligence_memo_drafts_written_by_check;
alter table public.diligence_memo_drafts
  add constraint diligence_memo_drafts_written_by_check
  check (written_by in ('memo_agent', 'assistant', 'import', 'partner'));
