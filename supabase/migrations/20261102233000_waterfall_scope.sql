-- One more waterfall term on vehicle_waterfall_terms (docs/spec/waterfall-terms.md §2,
-- packages/fund-engine/src/carry.ts `WaterfallScope`):
--
--   waterfall_scope  'fund' (the default): one waterfall on the LPs' pooled amounts, the reading
--                    every vehicle had before this existed. 'per_lp': each distribution, and the
--                    close's hypothetical liquidation, is divided among the LPs by their share of
--                    contributed capital first, and each LP's share runs through its own tiers.
--                    European and straight terms only; the app refuses 'per_lp' with 'american'.
--
-- ADDITIVE, AND IT MUST BE APPLIED BEFORE THE RELEASE THAT WRITES IT. The live release reads the
-- row with select * and doesn't know the column; the release that saves the terms writes it on
-- every save, so saving fails until the column exists. Safe to run twice.

alter table public.vehicle_waterfall_terms
  add column if not exists waterfall_scope text not null default 'fund';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vehicle_waterfall_terms_waterfall_scope_check'
      and conrelid = 'public.vehicle_waterfall_terms'::regclass
  ) then
    alter table public.vehicle_waterfall_terms
      add constraint vehicle_waterfall_terms_waterfall_scope_check
      check (waterfall_scope in ('fund', 'per_lp'));
  end if;
end $$;
