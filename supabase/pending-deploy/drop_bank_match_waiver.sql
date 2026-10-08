-- STAGED — DO NOT MOVE INTO supabase/migrations/ UNTIL a release built from main at commit
-- 27fddb55 or later (the ledger-one-writer set) is deployed. That release stops writing these
-- columns (postWithoutBankMatch went in 0acd9570); the release before it still writes them on
-- every waiver, and dropping them under it would fail those writes. Nothing reads them. Rename to a current
-- timestamp when moving it (CLAUDE.md).

alter table public.journal_entries drop column if exists bank_match_waived_at;
alter table public.journal_entries drop column if exists bank_match_waived_by;
