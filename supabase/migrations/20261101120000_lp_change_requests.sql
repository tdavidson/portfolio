-- LP change requests: an investor asks, the fund's staff approve.
--
-- An LP can already see their record and message the fund; changing anything went through staff by
-- email. A change request makes that a record with a state. The investor's primary LP account
-- (never an authorized user, whose access is read-only) asks for one of:
--
--   * profile          a change to an entity's record (address, notice email, entity type,
--                      formation jurisdiction, signatories) or the investor's contact details;
--   * authorized_user  portal access for someone acting for them (an advisor, an accountant).
--
-- Nothing changes until someone at the fund approves it. Approving runs the same function staff use
-- to make the change directly (lib/lps/records.ts updateEntityProfile, lib/lps/portal-access.ts
-- addAuthorizedUser), as the approver, with the approver's access. lib/lps/change-requests.ts.
--
-- Additive and safe to apply before the release that uses it.

create table if not exists public.lp_change_requests (
  id                uuid primary key default gen_random_uuid(),
  fund_id           uuid not null references funds(id) on delete cascade,
  lp_investor_id    uuid not null references lp_investors(id) on delete cascade,
  -- The entity a profile change is for. Null for an authorized-user request (it is per investor).
  lp_entity_id      uuid references lp_entities(id) on delete cascade,
  kind              text not null check (kind in ('profile', 'authorized_user')),
  -- What was asked for, already validated: { entity?, investor? } or { email, display_name? }.
  payload           jsonb not null default '{}'::jsonb,
  -- The record as it was when asked, for the reviewer's before and after.
  current           jsonb not null default '{}'::jsonb,
  note              text,
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by_account_id uuid references lp_accounts(id) on delete set null,
  requested_by_email text,
  decided_by        uuid references auth.users(id) on delete set null,
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz not null default now()
);

create index if not exists lp_change_requests_open_idx
  on public.lp_change_requests (fund_id, created_at desc) where status = 'pending';
create index if not exists lp_change_requests_investor_idx
  on public.lp_change_requests (lp_investor_id, created_at desc);

-- Read and written only by the portal and staff routes and tools, with the service role. RLS with no
-- policies denies every row if a grant ever creeps back.
revoke all on public.lp_change_requests from anon, authenticated;
grant select, insert, update, delete on public.lp_change_requests to service_role;
alter table public.lp_change_requests enable row level security;
