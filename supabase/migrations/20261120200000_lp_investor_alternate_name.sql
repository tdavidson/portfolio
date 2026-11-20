-- A second name for an investor, so a search finds them by either: the entity's name and the
-- person behind it, or a family name and the trust's. Search only; reports print `name`.
alter table public.lp_investors
  add column if not exists alternate_name text;

alter table public.lp_investors
  drop constraint if exists lp_investors_alternate_name_length;
alter table public.lp_investors
  add constraint lp_investors_alternate_name_length
  check (alternate_name is null or char_length(alternate_name) <= 500);
