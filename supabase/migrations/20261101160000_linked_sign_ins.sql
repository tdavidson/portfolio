-- Linked sign-ins: one person who works for several funds on this deployment (an outside fund
-- administrator, tax preparer or auditor, usually) links the sign-in they hold in each fund, so one
-- assistant connection can switch between those funds (use_fund), acting in each as that fund's
-- own member, with that member's role, grants and audit trail.
--
-- One email is still one fund (fund_members.user_id stays unique). A link proves the same person
-- controls both sign-ins: a code shown to one, entered while signed in as the other.
-- lib/account-links.ts; the pool itself is lib/agent/master-admin.ts.

create table public.account_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  group_id uuid not null,
  linked_at timestamptz not null default now()
);
create index account_links_group_idx on public.account_links (group_id);

create table public.account_link_codes (
  -- sha256 of the code; the code itself is shown once and never stored.
  code_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index account_link_codes_user_idx on public.account_link_codes (user_id);

-- Service role only: read and written by /api/account/links and the connector's pool lookup.
revoke all on public.account_links from anon, authenticated;
grant select, insert, update, delete on public.account_links to service_role;
alter table public.account_links enable row level security;

revoke all on public.account_link_codes from anon, authenticated;
grant select, insert, update, delete on public.account_link_codes to service_role;
alter table public.account_link_codes enable row level security;

-- Each fund decides whether its members' sign-ins may be linked. On by default: a link only lets
-- one connection act as each member with that member's own access, which the person could already
-- do with a connection per fund.
alter table public.fund_settings
  add column if not exists allow_linked_sign_ins boolean not null default true;

select public.grant_fund_settings_member_columns();
