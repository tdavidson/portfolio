-- One more waterfall term on vehicle_waterfall_terms (docs/spec/waterfall-terms.md §2,
-- packages/fund-engine/src/carry.ts `PerLpLiquidation`):
--
--   per_lp_liquidation  Per-LP terms only (waterfall_scope = 'per_lp'). How the close's
--                       hypothetical liquidation is divided among the LPs:
--                       'contributions' (the default, and every vehicle's reading before this):
--                       by each LP's share of contributed capital.
--                       'capital_account': each LP liquidates at its own capital account, gross
--                       of carry, the way many fund administrators accrue per-LP carry.
--
-- ADDITIVE, AND IT MUST BE APPLIED BEFORE THE RELEASE THAT WRITES IT: saving terms writes the
-- column on every save, so saving fails until it exists. Safe to run twice.

alter table public.vehicle_waterfall_terms
  add column if not exists per_lp_liquidation text not null default 'contributions';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vehicle_waterfall_terms_per_lp_liquidation_check'
      and conrelid = 'public.vehicle_waterfall_terms'::regclass
  ) then
    alter table public.vehicle_waterfall_terms
      add constraint vehicle_waterfall_terms_per_lp_liquidation_check
      check (per_lp_liquidation in ('contributions', 'capital_account'));
  end if;
end $$;
