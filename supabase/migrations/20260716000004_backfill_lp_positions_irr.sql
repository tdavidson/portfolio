-- Backfill lp_positions.irr from the snapshots the positions were migrated from.
--
-- lp_positions was backfilled from every snapshot's lp_investments (20260716000000), but the
-- irr column didn't exist yet (added in 20260716000002), so the reported IRR each snapshot
-- carried never came across. IRR is NOT derivable from a single dated position, so a
-- single-cutover tracking vehicle shows a blank IRR unless the stored figure is present — which
-- is exactly the gap here.
--
-- Copy each snapshot row's irr onto the matching position, using the SAME join the original
-- backfill used: same fund, entity, vehicle-matched-by-name, and the snapshot's as_of_date
-- (falling back to its created date). Non-destructive: only fills positions whose irr is still
-- null, so any IRR entered by hand or re-imported later is preserved. Where two snapshots map to
-- the same (vehicle, entity, date), the most recently created snapshot's IRR wins — consistent
-- with the "later import wins" rule the position backfill used.
--
-- LEDGER VEHICLES ARE EXCLUDED. A vehicle whose capital_source is 'ledger' reads its capital from
-- posted journal entries and ignores lp_positions entirely, so an IRR on its (stray) positions
-- would never be shown and shouldn't be written. Keying off capital_source rather than names keeps
-- it correct as that set changes.

with src as (
  select distinct on (li.fund_id, fv.id, li.entity_id, coalesce(s.as_of_date, s.created_at::date))
    li.fund_id,
    fv.id                                        as vehicle_id,
    li.entity_id                                 as lp_entity_id,
    coalesce(s.as_of_date, s.created_at::date)   as as_of_date,
    li.irr
  from public.lp_investments li
  join public.lp_snapshots s on s.id = li.snapshot_id
  join public.fund_vehicles fv on fv.fund_id = li.fund_id and fv.name = li.portfolio_group
  where coalesce(li.calc_generated, false) = false
    and li.irr is not null
    and not exists (
      select 1 from public.vehicle_accounting_settings vas
      where vas.fund_id = li.fund_id and vas.vehicle_id = fv.id and vas.capital_source = 'ledger'
    )
  order by li.fund_id, fv.id, li.entity_id, coalesce(s.as_of_date, s.created_at::date), s.created_at desc
)
update public.lp_positions p
set irr = src.irr
from src
where p.fund_id      = src.fund_id
  and p.vehicle_id   = src.vehicle_id
  and p.lp_entity_id = src.lp_entity_id
  and p.as_of_date   = src.as_of_date
  and p.irr is null;
