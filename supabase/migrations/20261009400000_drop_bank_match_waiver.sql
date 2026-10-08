-- supabase/migrations/20261009400000_drop_bank_match_waiver.sql
--
-- Staged in supabase/pending-deploy/ until a release built from main at commit 27fddb55 or later
-- was deployed: that release stopped writing these columns (postWithoutBankMatch went in
-- 0acd9570), and nothing reads them.

alter table public.journal_entries drop column if exists bank_match_waived_at;
alter table public.journal_entries drop column if exists bank_match_waived_by;
