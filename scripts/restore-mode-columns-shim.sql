-- TEMPORARY compatibility shim for the window between applying 20261006174711 and deploying the
-- unified code. Run it ONLY if scripts/check-dropped-mode-columns.sql returned "ACT".
--
-- NOT a migration, deliberately. 20261006174711 is already recorded as applied; adding a migration
-- that re-adds what it dropped would leave the migration ledger describing a schema nobody wants
-- to end up with. This is an ad-hoc repair of a transitional state, so it lives in scripts/.
--
-- WHAT IT CANNOT DO: dropping a column drops its data. The previous capital_source values are
-- gone and no DDL brings them back. Replace the placeholder names below with the entities that are
-- fully onboarded to accounting, lower-cased, before running it; a vehicle wrongly set to 'ledger' will report zeros on the
-- committed build, and one wrongly left at 'events' is the bug this is repairing.
--
-- AFTER DEPLOYING the unified code these columns are read by nothing. Leave them (harmless) or
-- drop them again by hand; do not add another migration for it.

-- 1. Put the columns back.
alter table public.vehicle_accounting_settings add column if not exists capital_source text;
alter table public.vehicle_accounting_settings add column if not exists history_mode text;

-- 2. LOOK FIRST. These are the rows step 3 will change, plus any onboarded vehicle that has no
--    settings row at all (which would still read as 'events' after step 3 alone).
select v.id as vehicle_id, v.name, s.id as settings_id, s.capital_source,
       (select count(*) from public.journal_entries e
         where e.vehicle_id = v.id and e.book = 'actual' and e.status = 'posted') as posted_entries,
       (select count(*) from public.lp_positions p where p.vehicle_id = v.id) as reported_positions
  from public.fund_vehicles v
  left join public.vehicle_accounting_settings s on s.vehicle_id = v.id and s.fund_id = v.fund_id
 where lower(v.name) in ('<first entity name>', '<second entity name>')
 order by v.name;

-- 3. Write. Run steps 3a and 3b together.

-- 3a. Vehicles that already have a settings row.
update public.vehicle_accounting_settings s
   set capital_source = 'ledger', updated_at = now()
  from public.fund_vehicles v
 where v.id = s.vehicle_id and v.fund_id = s.fund_id
   and lower(v.name) in ('<first entity name>', '<second entity name>');

-- 3b. Vehicles that have none. `loadCapitalSource` defaults a missing row to 'events', so an
--     onboarded vehicle without one needs the row, not just the column.
insert into public.vehicle_accounting_settings (fund_id, vehicle_id, capital_source)
select v.fund_id, v.id, 'ledger'
  from public.fund_vehicles v
 where lower(v.name) in ('<first entity name>', '<second entity name>')
   and not exists (
     select 1 from public.vehicle_accounting_settings s
      where s.vehicle_id = v.id and s.fund_id = v.fund_id
   );

-- 4. Confirm: both vehicles should now read 'ledger'.
select v.name, s.capital_source
  from public.fund_vehicles v
  join public.vehicle_accounting_settings s on s.vehicle_id = v.id and s.fund_id = v.fund_id
 where lower(v.name) in ('<first entity name>', '<second entity name>')
 order by v.name;
