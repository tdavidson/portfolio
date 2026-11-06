-- supabase/migrations/20261106040000_lp_letter_template_voice.sql
--
-- A letter template becomes the fund's own letter for the lp-quarterly-letter skill. The skill in the
-- repo is only the process and a general outline; each fund's structure and voice live here.
--
--   structure     The fund's letter layout: sections in order, headings, fixed paragraphs, tables.
--                 Replaces the skill's general outline. Learned from past letters, then edited.
--   examples      Sample passages for each part of the letter, with invented companies and figures.
--   house_rules   Standing instructions for every letter (names, formats, what to always or never
--                 say). They add to the voice, whichever voice applies.
--   source_files  The documents a voice was learned from: [{ "filename": text, "chars": int }].
--
-- Additive. New columns on an existing table keep its grants and RLS policies, so nothing else is
-- needed. The app writes these columns, so apply this before deploying the release that uses them.

alter table public.lp_letter_templates add column if not exists structure text;
alter table public.lp_letter_templates add column if not exists examples text;
alter table public.lp_letter_templates add column if not exists house_rules text;
alter table public.lp_letter_templates add column if not exists source_files jsonb;
