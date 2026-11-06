-- supabase/migrations/20261106050000_lp_letter_content.sql
--
-- The structured letter (lib/lp-letters/content.ts): the letter's sections in order, each with its
-- heading, its text and the sources it was written from (a copy of the brief's figures, events,
-- KPIs and updates for that section). Every writer saves here; full_draft and company_narratives
-- become copies made from it for the portal, the PDF, the exports and older tools. Letters saved
-- before this keep a null content and are read from full_draft.
--
-- Additive. A new column on an existing table keeps its grants and RLS policies. The app writes it,
-- so apply this before deploying the release that uses it.

alter table public.lp_letters add column if not exists content jsonb;
