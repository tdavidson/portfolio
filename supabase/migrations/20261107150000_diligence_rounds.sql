-- Diligence rounds: a deal's diligence happens in successive rounds (the first data room, a
-- follow-up request, confirmatory diligence), and the evidence, the memo and the scores are kept
-- per round instead of being overwritten in place.
--
-- A round owns the memo drafts written in it. The deal's working draft is still its latest open
-- draft row, so every stage keeps working on the current round without knowing about rounds:
-- starting the next round closes the current one and copies its latest draft forward as the new
-- round's first draft. A closed round's drafts are frozen (only finalizing is allowed), so each
-- round's memo, findings and scoring table stay as they were when it closed.
--
-- Documents (and so their call transcripts), notes and attention items record the round they
-- arrived in. A trigger fills round_id on insert with the deal's current round, so no insert path
-- has to know.
--
-- Additive. Every existing deal gets an open round 1 holding everything it has today.

create table if not exists public.diligence_rounds (
  id            uuid        primary key default gen_random_uuid(),
  fund_id       uuid        not null references funds(id) on delete cascade,
  deal_id       uuid        not null references diligence_deals(id) on delete cascade,
  round_number  int         not null check (round_number >= 1),
  label         text        not null default '',
  status        text        not null default 'open' check (status in ('open', 'closed')),
  -- The partners' call when the round closed.
  outcome       text        check (outcome in ('advance', 'hold', 'pass', 'invest')),
  summary       text,
  -- What to ask the company for next, built when the round closes: checklist items still
  -- missing or partial, open attention items and the data room's gaps.
  request_list  jsonb       not null default '[]'::jsonb,
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  closed_by     uuid        references auth.users(id),
  created_by    uuid        references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint diligence_rounds_close_consistency check (
    (status = 'open' and closed_at is null) or (status = 'closed' and closed_at is not null)
  )
);

create unique index if not exists diligence_rounds_deal_number_uq on public.diligence_rounds (deal_id, round_number);
create unique index if not exists diligence_rounds_one_open_uq on public.diligence_rounds (deal_id) where status = 'open';
create index if not exists diligence_rounds_fund_idx on public.diligence_rounds (fund_id);

grant select on public.diligence_rounds to anon;
grant select, insert, update, delete on public.diligence_rounds to authenticated, service_role;

alter table public.diligence_rounds enable row level security;

-- The same rules as the other diligence tables: diligence read access to read, write access to
-- write (20260902174637_enforce_domain_access_rls.sql), and only the deals of the caller's entities
-- (20261007100400_diligence_entity.sql).
drop policy if exists "diligence_rounds read needs diligence" on public.diligence_rounds;
create policy "diligence_rounds read needs diligence"
  on public.diligence_rounds for select to authenticated
  using (fund_id = any(public.fund_ids_readable('diligence')));
drop policy if exists "diligence_rounds insert needs diligence write" on public.diligence_rounds;
create policy "diligence_rounds insert needs diligence write"
  on public.diligence_rounds for insert to authenticated
  with check (fund_id = any(public.fund_ids_writable('diligence')));
drop policy if exists "diligence_rounds update needs diligence write" on public.diligence_rounds;
create policy "diligence_rounds update needs diligence write"
  on public.diligence_rounds for update to authenticated
  using (fund_id = any(public.fund_ids_writable('diligence')))
  with check (fund_id = any(public.fund_ids_writable('diligence')));
drop policy if exists "diligence_rounds delete needs diligence write" on public.diligence_rounds;
create policy "diligence_rounds delete needs diligence write"
  on public.diligence_rounds for delete to authenticated
  using (fund_id = any(public.fund_ids_writable('diligence')));
drop policy if exists "Only the caller's entities" on public.diligence_rounds;
create policy "Only the caller's entities"
  on public.diligence_rounds as restrictive for all to authenticated
  using (fund_id = any((select public.unscoped_fund_ids())::uuid[]) or deal_id = any((select public.diligence_ids_readable())::uuid[]))
  with check (fund_id = any((select public.unscoped_fund_ids())::uuid[]) or deal_id = any((select public.diligence_ids_readable())::uuid[]));

drop trigger if exists diligence_rounds_set_updated_at on public.diligence_rounds;
create trigger diligence_rounds_set_updated_at
  before update on public.diligence_rounds
  for each row execute function set_updated_at();

-- The round each record arrived in.
alter table public.diligence_memo_drafts     add column if not exists round_id uuid references public.diligence_rounds(id) on delete set null;
alter table public.diligence_documents       add column if not exists round_id uuid references public.diligence_rounds(id) on delete set null;
alter table public.diligence_notes           add column if not exists round_id uuid references public.diligence_rounds(id) on delete set null;
alter table public.diligence_attention_items add column if not exists round_id uuid references public.diligence_rounds(id) on delete set null;

create index if not exists diligence_memo_drafts_round_idx      on public.diligence_memo_drafts (round_id, created_at desc);
create index if not exists diligence_documents_round_idx        on public.diligence_documents (round_id);
create index if not exists diligence_notes_round_idx            on public.diligence_notes (round_id);
create index if not exists diligence_attention_items_round_idx  on public.diligence_attention_items (round_id);

-- Backfill: round 1 for every deal, holding everything it has.
insert into public.diligence_rounds (fund_id, deal_id, round_number, label, status, opened_at, created_by)
select d.fund_id, d.id, 1, 'Initial data room', 'open', d.created_at, d.created_by
from public.diligence_deals d
where not exists (select 1 from public.diligence_rounds r where r.deal_id = d.id);

update public.diligence_memo_drafts t set round_id = r.id
  from public.diligence_rounds r where r.deal_id = t.deal_id and r.round_number = 1 and t.round_id is null;
update public.diligence_documents t set round_id = r.id
  from public.diligence_rounds r where r.deal_id = t.deal_id and r.round_number = 1 and t.round_id is null;
update public.diligence_notes t set round_id = r.id
  from public.diligence_rounds r where r.deal_id = t.deal_id and r.round_number = 1 and t.round_id is null;
update public.diligence_attention_items t set round_id = r.id
  from public.diligence_rounds r where r.deal_id = t.deal_id and r.round_number = 1 and t.round_id is null;

-- A new deal starts in round 1.
create or replace function public.diligence_deal_first_round()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.diligence_rounds (fund_id, deal_id, round_number, label, status, opened_at, created_by)
  values (new.fund_id, new.id, 1, 'Initial data room', 'open', coalesce(new.created_at, now()), new.created_by)
  on conflict do nothing;
  return new;
end;
$$;
revoke execute on function public.diligence_deal_first_round() from public, anon, authenticated;

drop trigger if exists diligence_deals_first_round on public.diligence_deals;
create trigger diligence_deals_first_round
  after insert on public.diligence_deals
  for each row execute function public.diligence_deal_first_round();

-- A record inserted without a round lands in the deal's current (latest) round. Triggers fire in name
-- order, so the drafts one is named to run before the frozen-round check below.
create or replace function public.diligence_set_round_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.round_id is null then
    select r.id into new.round_id
    from public.diligence_rounds r
    where r.deal_id = new.deal_id
    order by r.round_number desc
    limit 1;
  end if;
  return new;
end;
$$;
revoke execute on function public.diligence_set_round_id() from public, anon, authenticated;

drop trigger if exists diligence_memo_drafts_0_set_round on public.diligence_memo_drafts;
create trigger diligence_memo_drafts_0_set_round before insert on public.diligence_memo_drafts
  for each row execute function public.diligence_set_round_id();
drop trigger if exists diligence_documents_set_round on public.diligence_documents;
create trigger diligence_documents_set_round before insert on public.diligence_documents
  for each row execute function public.diligence_set_round_id();
drop trigger if exists diligence_notes_set_round on public.diligence_notes;
create trigger diligence_notes_set_round before insert on public.diligence_notes
  for each row execute function public.diligence_set_round_id();
drop trigger if exists diligence_attention_items_set_round on public.diligence_attention_items;
create trigger diligence_attention_items_set_round before insert on public.diligence_attention_items
  for each row execute function public.diligence_set_round_id();

-- A closed round's drafts are frozen: no new drafts in it, and no change to a draft's evidence,
-- memo or scores. Finalizing (is_draft, finalized_at, finalized_by) is still allowed, so a round's
-- memo can be finalized after the round closes.
create or replace function public.diligence_memo_drafts_round_frozen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_number int;
begin
  if new.round_id is null then
    return new;
  end if;
  select r.status, r.round_number into v_status, v_number from public.diligence_rounds r where r.id = new.round_id;
  if v_status is distinct from 'closed' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Diligence round % is closed. Start the next round to keep working on this deal.', v_number
      using errcode = 'check_violation';
  end if;
  if new.ingestion_output is distinct from old.ingestion_output
     or new.research_output is distinct from old.research_output
     or new.qa_answers is distinct from old.qa_answers
     or new.memo_draft_output is distinct from old.memo_draft_output
     or new.review_flags is distinct from old.review_flags
     or new.brief_snapshot is distinct from old.brief_snapshot
     or new.round_id is distinct from old.round_id then
    raise exception 'Diligence round % is closed, so its memo, findings and scores are frozen. Start the next round to keep working on this deal.', v_number
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke execute on function public.diligence_memo_drafts_round_frozen() from public, anon, authenticated;

drop trigger if exists diligence_memo_drafts_round_frozen on public.diligence_memo_drafts;
create trigger diligence_memo_drafts_round_frozen
  before insert or update on public.diligence_memo_drafts
  for each row execute function public.diligence_memo_drafts_round_frozen();
