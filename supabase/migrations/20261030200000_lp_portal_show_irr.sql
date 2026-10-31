-- Whether the investor portal's overview shows each fund's IRR. Off by default: some managers
-- prefer not to show IRR in a portal. The downloadable statement and staff pages are unaffected.
alter table public.fund_settings
  add column if not exists lp_portal_show_irr boolean not null default false;

select public.grant_fund_settings_member_columns();
