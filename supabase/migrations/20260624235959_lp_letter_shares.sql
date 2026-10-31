-- LP letter sharing (Phase 3 of LP reporting).
--
-- Mirrors lp_snapshot_shares: an explicit, per-investor, auditable record that a
-- finalized LP letter is visible in that investor's portal. The LP read path
-- resolves shared letters via get_my_lp_investor_ids() and is served only
-- through admin-client portal APIs (LPs have no direct Data API access to the
-- GP lp_* tables), and gated by the fund's lp_portal_enabled switch.

create table public.lp_letter_shares (
  id             uuid        primary key default gen_random_uuid(),
  letter_id      uuid        not null references lp_letters(id) on delete cascade,
  lp_investor_id uuid        not null references lp_investors(id) on delete cascade,
  fund_id        uuid        not null references funds(id) on delete cascade,
  shared_at      timestamptz not null default now(),
  shared_by      uuid        references auth.users(id) on delete set null,
  unique (letter_id, lp_investor_id)
);
create index lp_letter_shares_letter_idx on public.lp_letter_shares (letter_id);
create index lp_letter_shares_investor_idx on public.lp_letter_shares (lp_investor_id);
create index lp_letter_shares_fund_idx on public.lp_letter_shares (fund_id);

grant select on public.lp_letter_shares to authenticated;
grant select, insert, update, delete on public.lp_letter_shares to service_role;

alter table public.lp_letter_shares enable row level security;

create policy lp_letter_shares_admin on public.lp_letter_shares
  for all to authenticated
  using (fund_id in (select fund_id from fund_members where user_id = auth.uid() and role = 'admin'))
  with check (fund_id in (select fund_id from fund_members where user_id = auth.uid() and role = 'admin'));

create policy lp_letter_shares_lp_read on public.lp_letter_shares
  for select to authenticated
  using (lp_investor_id = any(public.get_my_lp_investor_ids()));
