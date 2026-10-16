-- Fund connections: two funds on one deployment agreeing that some of their LPs are the same LP.
--
-- An investor record belongs to one fund. When an LP invests with two funds on the same platform
-- (two funds of one firm, or a fund split out of another), each fund has its own record, and a
-- report card that should show everything the LP holds has to know the two are the same person.
-- Nothing about that is specific to any fund: any admin may ask any other fund to connect.
--
-- Two levels of consent, both needed before anything crosses between funds:
--   1. fund_connections — an admin of one fund asks to connect with another fund (named by one of
--      its admins' email); an admin of that fund accepts. Either side may disconnect at any time,
--      which removes every pair under it.
--   2. lp_investor_links — under an active connection, a pair says "our investor X is your investor
--      Y". Each side's admin approves it; the side that proposes a pair approves it by proposing.
--      A report card combines positions only through a pair BOTH sides have approved.
-- fund_connection_events is the audit trail: every request, answer, pair and removal.
--
-- No row here is readable through the Data API: every reader and writer is an admin-only settings
-- route (or a report generator) holding the service role. Granted to service_role alone, with no
-- authenticated policies, so RLS denies by default if a grant ever creeps back.

create table if not exists public.fund_connections (
  id                uuid primary key default gen_random_uuid(),
  requester_fund_id uuid not null references public.funds(id) on delete cascade,
  recipient_fund_id uuid not null references public.funds(id) on delete cascade,
  status            text not null default 'pending'
                    check (status in ('pending', 'active', 'declined', 'cancelled', 'disconnected')),
  requested_by      uuid references auth.users(id) on delete set null,
  requested_at      timestamptz not null default now(),
  responded_by      uuid references auth.users(id) on delete set null,
  responded_at      timestamptz,
  ended_by_fund_id  uuid references public.funds(id) on delete set null,
  ended_at          timestamptz,
  check (requester_fund_id <> recipient_fund_id)
);

-- One live connection (pending or active) per pair of funds, whichever side asked.
create unique index if not exists fund_connections_live_pair
  on public.fund_connections (least(requester_fund_id, recipient_fund_id), greatest(requester_fund_id, recipient_fund_id))
  where status in ('pending', 'active');
create index if not exists fund_connections_requester_idx on public.fund_connections (requester_fund_id);
create index if not exists fund_connections_recipient_idx on public.fund_connections (recipient_fund_id);

create table if not exists public.lp_investor_links (
  id                    uuid primary key default gen_random_uuid(),
  connection_id         uuid not null references public.fund_connections(id) on delete cascade,
  -- The requester fund's investor, and the recipient fund's.
  requester_investor_id uuid not null references public.lp_investors(id) on delete cascade,
  recipient_investor_id uuid not null references public.lp_investors(id) on delete cascade,
  requester_approved_by uuid references auth.users(id) on delete set null,
  requester_approved_at timestamptz,
  recipient_approved_by uuid references auth.users(id) on delete set null,
  recipient_approved_at timestamptz,
  approved              boolean generated always as (requester_approved_at is not null and recipient_approved_at is not null) stored,
  created_at            timestamptz not null default now(),
  -- One counterpart per investor per connection: an LP is one LP.
  unique (connection_id, requester_investor_id),
  unique (connection_id, recipient_investor_id)
);

create index if not exists lp_investor_links_requester_idx on public.lp_investor_links (requester_investor_id) where approved;
create index if not exists lp_investor_links_recipient_idx on public.lp_investor_links (recipient_investor_id) where approved;

-- A pair must join the connection's two funds, and only while the connection is active.
create or replace function public.lp_investor_links_check()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c fund_connections%rowtype;
begin
  select * into c from fund_connections where id = new.connection_id;
  if c.status <> 'active' then
    raise exception 'lp_investor_links: the connection is not active';
  end if;
  if not exists (select 1 from lp_investors where id = new.requester_investor_id and fund_id = c.requester_fund_id) then
    raise exception 'lp_investor_links: requester_investor_id is not an investor of the requesting fund';
  end if;
  if not exists (select 1 from lp_investors where id = new.recipient_investor_id and fund_id = c.recipient_fund_id) then
    raise exception 'lp_investor_links: recipient_investor_id is not an investor of the recipient fund';
  end if;
  return new;
end;
$$;

drop trigger if exists lp_investor_links_check on public.lp_investor_links;
create trigger lp_investor_links_check
  before insert or update of connection_id, requester_investor_id, recipient_investor_id on public.lp_investor_links
  for each row execute function public.lp_investor_links_check();

create table if not exists public.fund_connection_events (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.fund_connections(id) on delete cascade,
  -- The fund whose admin acted.
  fund_id       uuid references public.funds(id) on delete set null,
  user_id       uuid references auth.users(id) on delete set null,
  action        text not null,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists fund_connection_events_connection_idx on public.fund_connection_events (connection_id, created_at);

-- Revoked explicitly: on a project created before the explicit-grants change, a new table still
-- picks up the default anon/authenticated privileges.
revoke all on public.fund_connections from anon, authenticated;
revoke all on public.lp_investor_links from anon, authenticated;
revoke all on public.fund_connection_events from anon, authenticated;
grant select, insert, update, delete on public.fund_connections to service_role;
grant select, insert, update, delete on public.lp_investor_links to service_role;
-- The audit trail is append-only.
grant select, insert on public.fund_connection_events to service_role;

alter table public.fund_connections enable row level security;
alter table public.lp_investor_links enable row level security;
alter table public.fund_connection_events enable row level security;

-- The fund an admin email belongs to, to address a connection request. Only the service role
-- may call it: it answers "is this address an admin, and of which fund", which no member should be
-- able to ask the Data API directly.
create or replace function public.fund_for_admin_email(p_email text)
returns table (fund_id uuid, fund_name text)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.name
    from auth.users u
    join fund_members m on m.user_id = u.id and m.role = 'admin'
    join funds f on f.id = m.fund_id
   where lower(u.email) = lower(btrim(p_email))
   limit 1;
$$;

revoke execute on function public.fund_for_admin_email(text) from public, anon, authenticated;
grant execute on function public.fund_for_admin_email(text) to service_role;
