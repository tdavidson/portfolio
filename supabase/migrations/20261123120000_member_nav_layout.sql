-- Per-user navigation layout (Settings → Layout): where the app's nav sits on desktop.
--   sidebar — the original column beside the page (default, so nothing changes for anyone)
--   fixed   — a full-height sidebar pinned to the left edge of the window
--   top     — a bar of sections across the top
-- It lives on the member's own row because it is a display preference of that member in that
-- fund, like display_name. Only the member writes it, through /api/settings/nav-layout (service
-- role); no grant or policy changes.
alter table public.fund_members
  add column if not exists nav_layout text not null default 'sidebar';

alter table public.fund_members
  drop constraint if exists fund_members_nav_layout_check;
alter table public.fund_members
  add constraint fund_members_nav_layout_check check (nav_layout in ('sidebar', 'fixed', 'top'));
