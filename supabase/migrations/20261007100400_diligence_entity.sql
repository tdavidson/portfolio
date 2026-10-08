-- Entity access, phase 3: diligence. A diligence record is evaluated FOR an entity, like the deal it
-- was promoted from, and its visibility follows that entity: admins see all; a member sees the
-- records of their entities. Unassigned records are admin-only until assigned, as deals are.
--
-- Every diligence table keys on deal_id → diligence_deals, so one helper answers for all of them.
-- See plans/spec-entity-access-and-portfolio.md.

alter table public.diligence_deals
  add column if not exists vehicle_id uuid references public.fund_vehicles(id) on delete set null;

create index if not exists diligence_deals_vehicle_idx on public.diligence_deals (fund_id, vehicle_id);

-- Backfill, once per record that has none:
--   1. the deal it was promoted from (inbound_deals.promoted_diligence_id);
--   2. otherwise the company it became, when exactly one entity holds that company;
--   3. otherwise the fund's only entity, when it has exactly one.
update public.diligence_deals d
   set vehicle_id = i.vehicle_id
  from public.inbound_deals i
 where i.promoted_diligence_id = d.id and i.vehicle_id is not null and d.vehicle_id is null;

update public.diligence_deals d
   set vehicle_id = (select cv.vehicle_id from public.company_vehicles cv where cv.company_id = d.promoted_company_id)
 where d.vehicle_id is null and d.promoted_company_id is not null
   and (select count(*) from public.company_vehicles cv where cv.company_id = d.promoted_company_id) = 1;

update public.diligence_deals d
   set vehicle_id = v.id
  from public.fund_vehicles v
 where d.vehicle_id is null and v.fund_id = d.fund_id and v.active and v.kind <> 'manco'
   and (select count(*) from public.fund_vehicles o where o.fund_id = d.fund_id and o.active and o.kind <> 'manco') = 1;

-- Promoting a deal to diligence carries the deal's entity.
create or replace function public.diligence_entity_from_deal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only within the deal's own fund, and only with an entity of that fund: the deal's columns come
  -- from its writer, and this function runs with definer rights.
  if new.promoted_diligence_id is not null and new.vehicle_id is not null
     and exists (select 1 from fund_vehicles v where v.id = new.vehicle_id and v.fund_id = new.fund_id) then
    update diligence_deals set vehicle_id = new.vehicle_id
     where id = new.promoted_diligence_id and vehicle_id is null and fund_id = new.fund_id;
  end if;
  return null;
end;
$$;

revoke execute on function public.diligence_entity_from_deal() from public, anon, authenticated;

drop trigger if exists diligence_entity_from_deal on public.inbound_deals;
create trigger diligence_entity_from_deal
  after insert or update of promoted_diligence_id, vehicle_id on public.inbound_deals
  for each row execute function public.diligence_entity_from_deal();

-- The diligence records the caller may see: their entities' (admins: everything in their funds).
create or replace function public.diligence_ids_readable()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(d.id), '{}'::uuid[]) from diligence_deals d
   where d.vehicle_id = any(public.vehicle_ids_readable())
      or d.fund_id = any(public.unscoped_fund_ids());
$$;

revoke execute on function public.diligence_ids_readable() from public, anon;
grant execute on function public.diligence_ids_readable() to authenticated, service_role;

do $$
declare
  t text;
  pred text;
  tables text[] := array[
    'diligence_deals', 'diligence_agent_sessions', 'diligence_attention_items', 'diligence_documents',
    'diligence_memo_drafts', 'diligence_notes', 'memo_agent_jobs', 'diligence_call_transcripts',
    'diligence_checklist_items', 'diligence_qa_chats'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    -- Unscoped callers first: it short-circuits the id list, and lets an admin insert a new record
    -- (whose id is not in that list yet).
    pred := 'fund_id = any((select public.unscoped_fund_ids())::uuid[]) or ' || case when t = 'diligence_deals'
      then 'id = any((select public.diligence_ids_readable())::uuid[])'
      else 'deal_id = any((select public.diligence_ids_readable())::uuid[])'
    end;
    execute format('drop policy if exists "Only the caller''s entities" on public.%I', t);
    execute format(
      'create policy "Only the caller''s entities" on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      t, pred, pred);
  end loop;
end $$;
