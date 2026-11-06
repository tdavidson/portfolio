-- supabase/migrations/20261106030000_lp_letter_provenance.sql
--
-- What a letter is, where it came from, and the part of it that is for the partners only.
--
--   vehicle_id      The letter's entity by id. Letters have only ever stored the entity's name
--                   (portfolio_group), which a rename or merge leaves behind. Backfilled by name;
--                   portfolio_group stays the key the code reads until every letter has an id.
--   source          'generated' (drafted in the app or by an assistant over MCP) or 'imported' (a
--                   letter as it was actually sent). Null for letters from before this was recorded.
--   generated_by    For a generated letter: 'fund_ai' (the fund's own AI provider) or 'assistant'.
--   skill_version   The lp-quarterly-letter skill version the letter was written to.
--   internal_notes  The draft's "Missing information" section, kept apart from full_draft so it can
--                   never be shared with the letter (lib/lp-letters/internal.ts).
--
-- Additive. New columns on an existing table keep its grants and RLS policies, so nothing else is
-- needed. The app writes these columns, so apply this before deploying the release that uses them.

alter table public.lp_letters add column if not exists vehicle_id uuid references public.fund_vehicles(id) on delete set null;
alter table public.lp_letters add column if not exists source text;
alter table public.lp_letters add column if not exists generated_by text;
alter table public.lp_letters add column if not exists skill_version text;
alter table public.lp_letters add column if not exists internal_notes text;

do $$ begin
  alter table public.lp_letters add constraint lp_letters_source_check check (source in ('generated', 'imported'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.lp_letters add constraint lp_letters_generated_by_check
    check (generated_by is null or (generated_by in ('fund_ai', 'assistant') and source = 'generated')));
exception when duplicate_object then null; end $$;

create index if not exists lp_letters_vehicle_idx on public.lp_letters (vehicle_id, period_year desc, period_quarter desc);

update public.lp_letters l
   set vehicle_id = v.id
  from public.fund_vehicles v
 where l.vehicle_id is null
   and v.fund_id = l.fund_id
   and v.name = l.portfolio_group;
