-- Item L "Other increase (decrease)" on each partner's K-1: transfers between
-- partners, and anything the close could not classify. Until now those had no line, so a partner
-- whose capital moved by any of them failed the roll-forward check and the package could not be
-- issued. Additive and defaulted: safe to apply before or after the release that writes it.
alter table public.k1_partners
  add column if not exists other_changes numeric not null default 0;
