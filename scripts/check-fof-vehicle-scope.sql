-- Read-only. Paste the whole thing into the Supabase SQL editor and run it.
--
-- ONE statement on purpose: the editor returns only the last result set, so a script of several
-- queries silently hands back just the final table.
--
-- WHY: the fund-of-funds figures are scoped by `fund_capital_events.vehicle_id` /
-- `fund_nav_statements.vehicle_id`, which is the only place a fund holding's entity is recorded.
-- Rows with no entity belong to no entity's schedule of investments, and `confirmFundCapitalEvent`
-- refuses to post them. Row 1 below is the number that decides whether a repair is needed.
--
-- Works BEFORE or AFTER 20261006220000, which is the migration that adds
-- `fund_holding_terms.vehicle_id`. Section 6 reads that column through to_jsonb so the query
-- parses either way: if the column does not exist yet the key is simply absent and every
-- commitment reports (NO ENTITY).

with counts as (
  select '1. EVENTS WITH NO ENTITY  <- the number that matters' as finding,
         ''::text as detail, count(*)::text as value, 1 as ord
    from public.fund_capital_events where vehicle_id is null
  union all
  select '2. events with an entity', '', count(*)::text, 2
    from public.fund_capital_events where vehicle_id is not null
  union all
  select '3. NAV statements with no entity', '', count(*)::text, 3
    from public.fund_nav_statements where vehicle_id is null
  union all
  select '4. NAV statements with an entity', '', count(*)::text, 4
    from public.fund_nav_statements where vehicle_id is not null
),
by_holding as (
  select '5. activity by holding and entity' as finding,
         c.name || '  ->  ' || coalesce(v.name, '(NO ENTITY)') as detail,
         count(*)::text as value, 5 as ord
    from public.fund_capital_events e
    join public.companies c on c.id = e.company_id
    left join public.fund_vehicles v on v.id = e.vehicle_id
   group by c.name, v.name
),
terms as (
  select '6. commitment by holding and entity' as finding,
         c.name || '  ->  ' || coalesce(v.name, '(NO ENTITY)') as detail,
         coalesce(t.commitment, 0)::text as value, 6 as ord
    from public.companies c
    left join public.fund_holding_terms t on t.company_id = c.id
    -- to_jsonb, not t.vehicle_id: the column does not exist until 20261006220000 is applied, and
    -- a direct reference would make this whole diagnostic fail to parse before then.
    left join public.fund_vehicles v on v.id = (to_jsonb(t) ->> 'vehicle_id')::uuid
   where c.holding_type = 'fund'
)
select finding, detail, value
  from (select * from counts union all select * from by_holding union all select * from terms) r
 order by ord, detail;

-- REPAIR, only if row 1 is greater than zero, and only where every fund-of-funds investment sits in
-- one vehicle. Put that vehicle's name in place of <fof vehicle name>, checking it against your
-- fund_vehicles rows, before running this.
--
--   update public.fund_capital_events e
--      set vehicle_id = v.id
--     from public.fund_vehicles v
--    where e.vehicle_id is null
--      and v.fund_id = e.fund_id
--      and lower(v.name) = lower('<fof vehicle name>');
--
--   update public.fund_nav_statements n
--      set vehicle_id = v.id
--     from public.fund_vehicles v
--    where n.vehicle_id is null
--      and v.fund_id = n.fund_id
--      and lower(v.name) = lower('<fof vehicle name>');
--
-- Then re-run 20261006220000 (it is re-runnable) so the terms backfill picks up the newly
-- resolvable holdings.
