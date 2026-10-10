-- Editing a forecast by hand.
--
-- A plan's draft is rebuilt whole from its inputs on every save, so a hand edit has to BE an input
-- or the next refresh erases it. `adjustments` holds them, applied after compiling
-- (lib/forecast/adjustments.ts):
--   entries  — entries a person added, each balanced: a one-off distribution, a corrected exit;
--              one may name the generated entry it replaces;
--   removed  — keys of generated entries (construction, opening settlements) taken out.
-- A P&L amount is still edited as a month override, as before.
--
-- Additive: safe to apply before the release that writes it.

alter table public.forecast_plans
  add column if not exists adjustments jsonb not null default '{"entries": [], "removed": []}'::jsonb;

alter table public.forecast_entries drop constraint if exists forecast_entries_source_check;
alter table public.forecast_entries
  add constraint forecast_entries_source_check check (source in ('rule', 'override', 'opening', 'construction', 'manual'));

create or replace function public.forecast_save(
  p_plan_id            uuid,
  p_fund_id            uuid,
  p_expected_revision  integer,
  p_plan_patch         jsonb,
  p_rule_upserts       jsonb,
  p_rule_deletes       uuid[],
  p_override_upserts   jsonb,
  p_override_deletes   uuid[],
  p_entries            jsonb,
  p_compiled           jsonb
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_plan public.forecast_plans%rowtype;
  v_entry jsonb;
  v_entry_id uuid;
begin
  select * into v_plan from public.forecast_plans
   where id = p_plan_id and fund_id = p_fund_id
   for update;
  if not found then
    raise exception 'Plan not found' using errcode = 'PT404';
  end if;
  if v_plan.revision <> p_expected_revision then
    raise exception 'The plan changed since you loaded it (revision % is now %). Reload and try again.',
      p_expected_revision, v_plan.revision using errcode = 'PT409';
  end if;

  if p_plan_patch is not null and p_plan_patch <> '{}'::jsonb then
    update public.forecast_plans set
      name           = case when p_plan_patch ? 'name' then p_plan_patch ->> 'name' else name end,
      scenario       = case when p_plan_patch ? 'scenario' then p_plan_patch ->> 'scenario' else scenario end,
      start_month    = case when p_plan_patch ? 'start_month' then (p_plan_patch ->> 'start_month')::date else start_month end,
      end_month      = case when p_plan_patch ? 'end_month' then (p_plan_patch ->> 'end_month')::date else end_month end,
      horizon_months = case when p_plan_patch ? 'horizon_months' then (p_plan_patch ->> 'horizon_months')::integer else horizon_months end,
      actuals_cutoff = case when p_plan_patch ? 'actuals_cutoff' then (p_plan_patch ->> 'actuals_cutoff')::date else actuals_cutoff end,
      status         = case when p_plan_patch ? 'status' then p_plan_patch ->> 'status' else status end,
      include_construction = case when p_plan_patch ? 'include_construction'
                                  then (p_plan_patch ->> 'include_construction')::boolean
                                  else include_construction end,
      opening_settlement_months = case when p_plan_patch ? 'opening_settlement_months'
                                       then (p_plan_patch ->> 'opening_settlement_months')::integer
                                       else opening_settlement_months end,
      adjustments    = case when p_plan_patch ? 'adjustments' then p_plan_patch -> 'adjustments' else adjustments end
    where id = p_plan_id;
  end if;

  if p_rule_deletes is not null and array_length(p_rule_deletes, 1) > 0 then
    delete from public.forecast_rules where plan_id = p_plan_id and id = any(p_rule_deletes);
  end if;
  if p_rule_upserts is not null and jsonb_array_length(p_rule_upserts) > 0 then
    insert into public.forecast_rules (id, plan_id, fund_id, vehicle_id, account_id, method, params, cash_timing, source, note)
    select r.id, p_plan_id, p_fund_id, v_plan.vehicle_id, r.account_id, r.method, r.params,
           coalesce(r.cash_timing, '{"mode":"same"}'::jsonb), coalesce(r.source, 'user'), r.note
      from jsonb_to_recordset(p_rule_upserts)
        as r(id uuid, account_id uuid, method text, params jsonb, cash_timing jsonb, source text, note text)
    on conflict (plan_id, account_id) do update set
      method = excluded.method, params = excluded.params, cash_timing = excluded.cash_timing,
      source = excluded.source, note = excluded.note, updated_at = now();
  end if;

  if p_override_deletes is not null and array_length(p_override_deletes, 1) > 0 then
    delete from public.forecast_overrides where plan_id = p_plan_id and id = any(p_override_deletes);
  end if;
  if p_override_upserts is not null and jsonb_array_length(p_override_upserts) > 0 then
    insert into public.forecast_overrides (id, plan_id, fund_id, vehicle_id, account_id, month, amount, note)
    select o.id, p_plan_id, p_fund_id, v_plan.vehicle_id, o.account_id, o.month, o.amount, o.note
      from jsonb_to_recordset(p_override_upserts)
        as o(id uuid, account_id uuid, month date, amount numeric, note text)
    on conflict (plan_id, account_id, month) do update set amount = excluded.amount, note = excluded.note;
  end if;

  -- The draft is rebuilt whole: it is a function of the inputs, never edited in place.
  delete from public.forecast_entries where plan_id = p_plan_id and version_id is null;
  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    insert into public.forecast_entries (plan_id, version_id, fund_id, vehicle_id, entry_date, kind, memo, account_id, rule_id, override_id, source)
    values (p_plan_id, null, p_fund_id, v_plan.vehicle_id, (v_entry ->> 'entry_date')::date, v_entry ->> 'kind',
            v_entry ->> 'memo', (v_entry ->> 'account_id')::uuid, (v_entry ->> 'rule_id')::uuid,
            (v_entry ->> 'override_id')::uuid, v_entry ->> 'source')
    returning id into v_entry_id;
    insert into public.forecast_postings (entry_id, fund_id, account_id, amount, currency)
    select v_entry_id, p_fund_id, p.account_id, p.amount, p.currency
      from jsonb_to_recordset(v_entry -> 'postings') as p(account_id uuid, amount numeric, currency text);
  end loop;

  update public.forecast_plans set
    revision = revision + 1,
    compiled_at = now(),
    compiled_cutoff = (p_compiled ->> 'cutoff')::date,
    compiled_closed_through = (p_compiled ->> 'closed_through')::date,
    updated_at = now()
  where id = p_plan_id;

  return v_plan.revision + 1;
end;
$$;

revoke all on function public.forecast_save(uuid, uuid, integer, jsonb, jsonb, uuid[], jsonb, uuid[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.forecast_save(uuid, uuid, integer, jsonb, jsonb, uuid[], jsonb, uuid[], jsonb, jsonb) to service_role;
