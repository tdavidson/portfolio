-- supabase/pending-deploy/investment_ownership_trigger.sql
--
-- STAGED — DO NOT MOVE INTO supabase/migrations/ UNTIL the release implementing
-- plans/plan-ledger-one-writer-a.md (adoption at posting) is deployed. Until then every
-- QuickBooks or manual post to an investment account would be refused, because nothing adopts
-- it. When moving it, rename it to a current timestamp (CLAUDE.md, "A migration that must wait
-- for a deploy"). Tested where it stands by scripts/check-investment-ownership.mjs.
--
-- THE BACKSTOP FOR "ONE WRITER OF INVESTMENT VALUE". A posted entry on the actual book may carry
-- a line on an investment account only if an investment transaction owns it: derived from one
-- (source_ref = 'txn:<id>'), adopted into one (investment_transactions.adopted_entry_id), or the
-- live reversal of an entry (the pair nets to zero). The application adopts at its two posting
-- choke points; this makes a future path that skips them fail loudly instead of silently.
--
-- Fires on the transition INTO posted/actual and on an investment line written onto a posted
-- entry — never on unrelated edits, so entries posted before this existed stay editable.
-- SECURITY DEFINER so the restrictive entity RLS can never hide an owning row from the check.

create or replace function public.is_investment_account(p_account_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from chart_of_accounts a
    where a.id = p_account_id
      and ((a.type = 'asset' and a.subtype in ('investment', 'unrealized', 'fx_translation'))
        or (a.subtype = 'realized_gain' and a.company_id is not null))
  )
$$;

create or replace function public.investment_entry_owned(p_entry_id uuid, p_fund_id uuid, p_source_ref text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    (coalesce(p_source_ref, '') like 'txn:%' and exists (
      select 1 from investment_transactions t
      where t.fund_id = p_fund_id and t.id::text = substr(p_source_ref, 5)))
    or exists (
      select 1 from investment_transactions t
      where t.fund_id = p_fund_id and t.adopted_entry_id = p_entry_id)
    or (coalesce(p_source_ref, '') like 'reversal:%' and exists (
      select 1 from journal_entries o
      where o.id::text = substr(p_source_ref, 10) and o.fund_id = p_fund_id and o.status = 'posted'
        and (o.reversed_by is null or o.reversed_by = p_entry_id)))
$$;

create or replace function public.assert_investment_entry_owned()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'posted' and new.book = 'actual'
     and (tg_op = 'INSERT' or old.status is distinct from 'posted' or old.book is distinct from 'actual')
     and exists (
       select 1 from journal_postings p
       where p.journal_entry_id = new.id and public.is_investment_account(p.account_id))
     and not public.investment_entry_owned(new.id, new.fund_id, new.source_ref)
  then
    raise exception 'Journal entry % posts to an investment account that no investment transaction owns', new.id
      using errcode = 'check_violation',
            hint = 'Record it as an investment transaction, or post it through the journal so it is adopted.';
  end if;
  return new;
end
$$;

create or replace function public.assert_investment_posting_owned()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  e record;
begin
  if not public.is_investment_account(new.account_id) then
    return new;
  end if;
  select id, fund_id, status, book, source_ref into e from journal_entries where id = new.journal_entry_id;
  if e.status = 'posted' and e.book = 'actual'
     and not public.investment_entry_owned(e.id, e.fund_id, e.source_ref) then
    raise exception 'Journal entry % posts to an investment account that no investment transaction owns', e.id
      using errcode = 'check_violation',
            hint = 'Record it as an investment transaction, or post it through the journal so it is adopted.';
  end if;
  return new;
end
$$;

drop trigger if exists journal_entries_investment_owned on public.journal_entries;
create trigger journal_entries_investment_owned
  before insert or update of status, book on public.journal_entries
  for each row execute function public.assert_investment_entry_owned();

drop trigger if exists journal_postings_investment_owned on public.journal_postings;
create trigger journal_postings_investment_owned
  before insert or update of account_id on public.journal_postings
  for each row execute function public.assert_investment_posting_owned();

revoke execute on function public.is_investment_account(uuid) from public, anon, authenticated;
revoke execute on function public.investment_entry_owned(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.assert_investment_entry_owned() from public, anon, authenticated;
revoke execute on function public.assert_investment_posting_owned() from public, anon, authenticated;
