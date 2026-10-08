-- STAGED — DO NOT MOVE INTO supabase/migrations/ UNTIL the release implementing
-- plans/plan-ledger-one-writer-a.md is deployed. That release stops writing these columns
-- (postWithoutBankMatch is gone); the release before it still writes them on every waiver, and
-- dropping them under it would fail those writes. Nothing reads them. Rename to a current
-- timestamp when moving it (CLAUDE.md).

alter table public.journal_entries drop column if exists bank_match_waived_at;
alter table public.journal_entries drop column if exists bank_match_waived_by;
