-- supabase/migrations/20261009100000_parsing_reviews_fund_register.sql
--
-- A manager's email about a fund holding proposes register rows — a NAV statement, a capital call,
-- a distribution — for a person to approve (plans/spec-ledger-one-writer.md §4). The proposals live
-- in the existing review queue, so the table gains:
--
--   payload     the proposed row as read from the document (lib/portfolio/fof-review-types.ts)
--   vehicle_id  the entity that holds the fund when the holding has exactly one; otherwise null,
--               chosen when the review is approved
--   issue_type  fund_nav, fund_capital_call, fund_distribution
--
-- No new table, so no Data API grants (CLAUDE.md): parsing_reviews already carries them.
--
-- ENTITY RLS. 20261007100200_entity_rls.sql scoped parsing_reviews by COMPANY only: a review was
-- about a portfolio company's metrics, which every entity holding that company may see. A fund
-- review is about ONE entity's position, and a fund held by two entities must not show one's NAV
-- to the other's members. So the restrictive policy is replaced by one that keeps the company rule
-- and adds the vehicle_id rule: a review naming an entity needs that entity; a FUND review naming
-- none is for unscoped callers to triage (as an entity-less row is everywhere else); any other
-- review naming none keeps its company-only rule.
--
-- Re-runnable: every step is guarded or idempotent.

alter table public.parsing_reviews add column if not exists payload jsonb;
alter table public.parsing_reviews
  add column if not exists vehicle_id uuid references public.fund_vehicles(id) on delete set null;

create index if not exists parsing_reviews_vehicle_id_idx
  on public.parsing_reviews (vehicle_id) where vehicle_id is not null;
-- The fund-holding panel lists one holding's open reviews.
create index if not exists parsing_reviews_open_by_company_idx
  on public.parsing_reviews (fund_id, company_id) where resolution is null;

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'parsing_reviews_issue_type_check'
       and conrelid = 'public.parsing_reviews'::regclass
  ) then
    alter table public.parsing_reviews drop constraint parsing_reviews_issue_type_check;
  end if;
end $$;

alter table public.parsing_reviews
  add constraint parsing_reviews_issue_type_check
  check (issue_type in (
    'new_company_detected', 'low_confidence', 'ambiguous_period', 'metric_not_found',
    'company_not_identified', 'duplicate_period', 'deal_extraction', 'routing_low_confidence',
    'multi_company_email', 'diligence_intake_pending',
    'fund_nav', 'fund_capital_call', 'fund_distribution'
  ));

-- A fund review is a proposal about one holding; without both it cannot be approved.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'parsing_reviews_fund_proposal_check'
       and conrelid = 'public.parsing_reviews'::regclass
  ) then
    alter table public.parsing_reviews
      add constraint parsing_reviews_fund_proposal_check
      check (issue_type not in ('fund_nav', 'fund_capital_call', 'fund_distribution')
             or (payload is not null and company_id is not null));
  end if;
end $$;

drop policy if exists "Only the caller's entities" on public.parsing_reviews;
create policy "Only the caller's entities" on public.parsing_reviews
  as restrictive for all to authenticated
  using (
    fund_id = any((select public.unscoped_fund_ids())::uuid[])
    or (
      company_id = any((select public.company_ids_readable())::uuid[])
      and (
        vehicle_id = any((select public.vehicle_ids_readable())::uuid[])
        or (vehicle_id is null and issue_type not in ('fund_nav', 'fund_capital_call', 'fund_distribution'))
      )
    )
  )
  with check (
    fund_id = any((select public.unscoped_fund_ids())::uuid[])
    or (
      company_id = any((select public.company_ids_readable())::uuid[])
      and (
        vehicle_id = any((select public.vehicle_ids_readable())::uuid[])
        or (vehicle_id is null and issue_type not in ('fund_nav', 'fund_capital_call', 'fund_distribution'))
      )
    )
  );
