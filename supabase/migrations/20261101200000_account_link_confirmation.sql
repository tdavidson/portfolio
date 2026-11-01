-- Linked sign-ins, second step: entering a code no longer links on its own. The code row records
-- who entered it, and the sign-in that showed the code confirms (lib/account-links.ts
-- confirmLinkRequest), on a screen naming the other address and fund. Reading a code out to someone
-- is then not enough to link a sign-in to theirs.
--
-- And linking is off by default for funds created from now on. Existing funds keep their setting.
--
-- Idempotent: safe to run twice.

alter table public.account_link_codes
  add column if not exists redeemed_by uuid references auth.users(id) on delete cascade,
  add column if not exists redeemed_at timestamptz;

-- Still service role only (20261101160000); restated so a fresh install that skipped it is safe.
revoke all on public.account_link_codes from anon, authenticated;
grant select, insert, update, delete on public.account_link_codes to service_role;

alter table public.fund_settings
  alter column allow_linked_sign_ins set default false;

select public.grant_fund_settings_member_columns();
