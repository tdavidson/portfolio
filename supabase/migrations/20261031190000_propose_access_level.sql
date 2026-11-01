-- The `propose` access level, and proposed journal entries.
--
-- `propose` sits between read and write (lib/access/effective.ts): everything read allows, plus
-- putting a change forward for someone with write to accept. Only accounting offers it
-- (DOMAIN_META.proposable), where a proposal is a draft journal entry marked with who proposed it
-- (lib/accounting/proposals.ts). An auditor proposes adjustments, a tax preparer proposes entries,
-- a fund administrator who isn't trusted to post proposes too, and someone with write posts,
-- edits or rejects each one.
--
-- Additive and safe to apply before the release that uses it: nothing writes `propose` or reads
-- `proposed_by` until that release ships.

-- 1. The two grant tables accept the new level. The inline checks from 20260716000008 carry
--    Postgres' generated names; drop whichever check constrains `level`, whatever it is called.
do $$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
      from pg_constraint c
     where c.contype = 'c'
       and c.conrelid in ('public.fund_member_access'::regclass, 'public.fund_domain_defaults'::regclass)
       and pg_get_constraintdef(c.oid) ilike '%level%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end;
$$;

alter table public.fund_member_access
  add constraint fund_member_access_level_check check (level in ('none', 'read', 'propose', 'write'));
alter table public.fund_domain_defaults
  add constraint fund_domain_defaults_level_check check (level in ('none', 'read', 'propose', 'write'));

-- 2. The SQL resolver. `domain_access()` returns the stored level as it is, so it can now return
--    'propose'. For the Data API a proposer is a reader: proposals are made through the app's own
--    routes and tools with the service role, never by writing a table directly, so `propose` ranks
--    with `read` here and every "at least write" policy (rank >= 2) still refuses it.
create or replace function public.access_rank(p_level text)
returns int
language sql
immutable
parallel safe
as $$
  select case p_level when 'write' then 2 when 'propose' then 1 when 'read' then 1 else 0 end;
$$;

-- 3. Who proposed a draft entry, and when. Null on every entry that wasn't proposed, including all
--    existing ones. A proposal stays a draft (status 'draft') until someone with write posts it,
--    and keeps these columns afterwards so the ledger shows where the entry came from.
alter table public.journal_entries
  add column if not exists proposed_by uuid references auth.users(id) on delete set null,
  add column if not exists proposed_at timestamptz;

create index if not exists journal_entries_open_proposals_idx
  on public.journal_entries (fund_id, proposed_at desc)
  where proposed_by is not null and status = 'draft';

comment on column public.journal_entries.proposed_by is
  'Set when a member with the propose level (not write) created this draft. Someone with write posts or rejects it.';
