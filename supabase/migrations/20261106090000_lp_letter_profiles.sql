-- LP letters, phase 4: letter profiles and imported letters.
--
-- 1. lp_letter_profiles: the fixed facts of one entity's letters, copied rather than written: its
--    legal and short names, the firm's name, whether it is investing or harvesting, the signatories,
--    company display names and former names, standing footnotes, the parties the letter names and
--    the fixed paragraphs it repeats. One row per entity (vehicle_id), plus at most one firm-wide row
--    (vehicle_id null) for defaults every entity shares. A profile points at the letter template
--    whose voice it uses. Keyed on fund_vehicles.id, so renaming or merging an entity keeps it.
--
--    Read and written only by the LP letter routes and tools, which hold the service-role key and
--    check lp_relations / lp_letters first. So it is granted to service_role alone, with RLS on and
--    no member policies: a member's own client can't read it around those checks.
--
-- 2. lp_letters.original_file: for an imported letter, the file as sent, kept in the private
--    lp-letter-originals bucket.
--
-- Additive.

create table if not exists public.lp_letter_profiles (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  vehicle_id uuid references public.fund_vehicles(id) on delete cascade,
  template_id uuid references public.lp_letter_templates(id) on delete set null,
  legal_name text,
  short_name text,
  firm_name text,
  fund_stage text check (fund_stage in ('investing', 'harvesting')),
  -- [{ "name": "...", "title": "..." }]
  signatories jsonb not null default '[]'::jsonb,
  -- [{ "company_id": "...", "display_name": "...", "former_names": ["..."], "status": "Wound Down" }]
  company_names jsonb not null default '[]'::jsonb,
  footnotes text,
  parties text,
  -- [{ "heading": "...", "text": "..." }]: paragraphs the letter repeats each quarter
  fixed_text jsonb not null default '[]'::jsonb,
  seeded_from_letter uuid references public.lp_letters(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create unique index if not exists lp_letter_profiles_one_per_vehicle
  on public.lp_letter_profiles (fund_id, vehicle_id) where vehicle_id is not null;
create unique index if not exists lp_letter_profiles_one_firm_wide
  on public.lp_letter_profiles (fund_id) where vehicle_id is null;

grant select, insert, update, delete on public.lp_letter_profiles to service_role;
revoke all on public.lp_letter_profiles from anon, authenticated;
alter table public.lp_letter_profiles enable row level security;

-- { "path": "<fund>/<letter>/<file>", "name": "...", "type": "...", "size": 123 }
alter table public.lp_letters add column if not exists original_file jsonb;

-- The files as sent. No storage policies: only the service role reads or writes them.
insert into storage.buckets (id, name, public) values ('lp-letter-originals', 'lp-letter-originals', false)
on conflict (id) do nothing;
