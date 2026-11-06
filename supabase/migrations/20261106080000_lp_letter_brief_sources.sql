-- LP letters, phase 3: what a letter's brief is written from.
--
-- 1. companies.current_update_at: when the company's stored "current update" text was last written.
--    The row's updated_at moves on any edit, so it can't say how old that text is. A trigger keeps
--    it, so every writer (the company page, the MCP tools, imports) sets it without code changes.
--    Existing text gets the row's updated_at as its best known date.
-- 2. lp_letters.partner_notes and lp_letters.source_documents: the partners' notes for one letter and
--    the documents they added as sources (a market report, a board deck), kept as extracted text.
--    Both are sources the letter may draw on; neither is shown to investors.

alter table public.companies add column if not exists current_update_at timestamptz;

update public.companies
   set current_update_at = updated_at
 where current_update_at is null
   and current_update is not null
   and btrim(current_update) <> '';

create or replace function public.companies_stamp_current_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.current_update is not null and btrim(new.current_update) <> '' and new.current_update_at is null then
      new.current_update_at := now();
    end if;
  elsif new.current_update is distinct from old.current_update then
    new.current_update_at := case when new.current_update is null or btrim(new.current_update) = '' then null else now() end;
  end if;
  return new;
end;
$$;

revoke execute on function public.companies_stamp_current_update() from anon, authenticated, public;

drop trigger if exists companies_stamp_current_update on public.companies;
create trigger companies_stamp_current_update
  before insert or update of current_update on public.companies
  for each row execute function public.companies_stamp_current_update();

alter table public.lp_letters add column if not exists partner_notes text;
alter table public.lp_letters add column if not exists source_documents jsonb not null default '[]'::jsonb;
