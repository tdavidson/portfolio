-- Backfill associate/GP member carry from the OLD model into the NEW one.
--
-- The old "GP Entity Ownership" table on the LPs page stored each associate member's carry in
-- lp_associates_overrides.carried_interest_pct, keyed by FREE-TEXT names (investor_entity,
-- associates_entity). The new carry tables on /funds/capital-accounts read carry from
-- partner_allocation_terms (category 'carried_interest', weight_override), keyed by IDS —
-- vehicle_id (the associate's fund_vehicles row) and lp_entity_id (the member). Because the
-- rebuild switched key models, associates that had carry configured on the old page came up
-- BLANK in the new carry table. This copies the old percentages across.
--
-- carryPct in the new model is DERIVED by normalizing each member's weight within the associate,
-- so the stored unit is irrelevant — copying carried_interest_pct straight into weight_override
-- preserves the relative split (two members at 50/50, or at 0.5/0.5, both derive to 50%).
--
-- Safety:
--   * Non-destructive — a member whose carry weight is ALREADY set is never overwritten, so any
--     carry entered directly in the new table wins.
--   * Names are matched case- and whitespace-insensitively; associate → fund_vehicles(kind
--     associate|gp), member → lp_entities(entity_name).
--   * Rows whose names don't resolve are skipped and reported via NOTICE — set those by hand.
--   * DISTINCT ON dedupes multiple old rows that resolve to the same (vehicle, member), keeping
--     the most recently updated, so the single-statement ON CONFLICT can't hit a row twice.

do $$
declare
  v_applied int;
  v_candidates int;
begin
  select count(*) into v_candidates
  from lp_associates_overrides
  where carried_interest_pct is not null and carried_interest_pct > 0;

  with resolved as (
    select distinct on (fv.id, le.id)
      o.fund_id,
      fv.id  as vehicle_id,
      le.id  as lp_entity_id,
      o.carried_interest_pct as pct
    from lp_associates_overrides o
    join fund_vehicles fv
      on fv.fund_id = o.fund_id
     and fv.kind in ('associate', 'gp')
     and lower(btrim(fv.name)) = lower(btrim(o.associates_entity))
    join lp_entities le
      on le.fund_id = o.fund_id
     and lower(btrim(le.entity_name)) = lower(btrim(o.investor_entity))
    where o.carried_interest_pct is not null and o.carried_interest_pct > 0
      -- Skip ledger vehicles, which are
      -- maintained on their own books and are deliberately left untouched by these backfills.
      and not exists (
        select 1 from vehicle_accounting_settings vas
        where vas.fund_id = o.fund_id and vas.vehicle_id = fv.id and vas.capital_source = 'ledger'
      )
    order by fv.id, le.id, o.updated_at desc nulls last
  ), applied as (
    insert into partner_allocation_terms (fund_id, vehicle_id, lp_entity_id, category, participates, weight_override)
    select fund_id, vehicle_id, lp_entity_id, 'carried_interest', true, pct
    from resolved
    on conflict (fund_id, vehicle_id, lp_entity_id, category)
    do update set weight_override = excluded.weight_override, participates = true
    where partner_allocation_terms.weight_override is null
    returning 1
  )
  select count(*) into v_applied from applied;

  raise notice 'associate carry backfill: applied % of % override rows (unresolved names skipped; already-set weights left untouched)', v_applied, v_candidates;
end $$;
