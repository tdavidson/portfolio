-- The GP's own capital and its carry on one distribution, and each line's own breakdown.
--
-- 1. A carry recipient that has also contributed (the GP's commitment) takes two lines on one
--    distribution: an LP line for its own capital and a carry line. complete_capital_operation
--    refused that as a "duplicate recipient". A recipient is now unique per (entity, role), and the
--    check against the journal adds an entity's lines together, since both post to its one capital
--    account.
-- 2. Each LP line can carry its own return of capital, preferred return and profit, frozen at
--    declaration, so a notice states the partner's figures rather than a share of fund-wide tiers.
--    Null on lines declared without a waterfall, and on every line declared before this.
-- 3. The register keeps the GP's carry-free share (its own capital, outside the tiers), which the
--    waterfall already computed but nothing stored.
--
-- Idempotent: safe to paste twice.

alter table public.distribution_lines add column if not exists return_of_capital numeric;
alter table public.distribution_lines add column if not exists preferred numeric;
alter table public.distribution_lines add column if not exists profit numeric;

comment on column public.distribution_lines.return_of_capital is
  'LP lines declared through the waterfall: the part of this line that returns capital. Null = not broken down.';
comment on column public.distribution_lines.preferred is
  'LP lines declared through the waterfall: the part of this line that pays the preferred return.';
comment on column public.distribution_lines.profit is
  'LP lines declared through the waterfall: the rest of this line (catch-up share, profit split, or profit on carry-free capital).';

alter table public.distributions add column if not exists wf_carry_free numeric;
alter table public.distributions add column if not exists wf_carry_free_capital numeric;

comment on column public.distributions.wf_carry_free is
  'What the carry recipients'' own capital took, outside the tiers.';
comment on column public.distributions.wf_carry_free_capital is
  'Of wf_carry_free, the part that returned their capital.';

create or replace function public.complete_capital_operation(
  p_fund_id uuid, p_vehicle_id uuid, p_kind text, p_register_id uuid, p_entry_ids uuid[], p_lines jsonb
) returns void language plpgsql set search_path = public as $$
declare
  register_state text;
  linked_ids uuid[];
  existing_count integer;
  expected_count integer;
  capital_sign integer;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Recipients are required'; end if;
  expected_count := jsonb_array_length(p_lines);
  if exists (select 1 from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric, role text)
    where x.amount is null or x.amount <= 0 or x.amount::text in ('NaN', 'Infinity', '-Infinity') or x.amount <> round(x.amount, 2)
      or not exists (select 1 from public.lp_entities e where e.id = x."lpEntityId" and e.fund_id = p_fund_id)) then
    raise exception 'Recipients and amounts must be valid for this fund';
  end if;
  -- A call: one line per partner. A distribution: one line per partner and role, so the GP's own
  -- capital and its carry can both be on it.
  if (select count(distinct (x->>'lpEntityId') || '|' || coalesce(case when p_kind = 'distribution' then x->>'role' end, ''))
      from jsonb_array_elements(p_lines) x) <> expected_count then raise exception 'Duplicate recipient'; end if;
  if p_kind = 'call' then
    select status, array[journal_entry_id] into register_state, linked_ids from public.capital_calls
      where id = p_register_id and fund_id = p_fund_id and vehicle_id = p_vehicle_id for update;
    capital_sign := -1;
  elsif p_kind = 'distribution' then
    select status, array_remove(array[journal_entry_id, carry_journal_entry_id], null) into register_state, linked_ids from public.distributions
      where id = p_register_id and fund_id = p_fund_id and vehicle_id = p_vehicle_id for update;
    capital_sign := 1;
    if exists (select 1 from jsonb_array_elements(p_lines) x where x->>'role' not in ('lp','carry') or x->>'role' is null) then raise exception 'Invalid recipient role'; end if;
    -- A breakdown is optional, on LP lines only, nonnegative, and adds to its line.
    if exists (select 1 from jsonb_to_recordset(p_lines) x(amount numeric, role text, "returnOfCapital" numeric, preferred numeric, profit numeric)
      where (x."returnOfCapital" is not null or x.preferred is not null or x.profit is not null)
        and (x.role <> 'lp' or x."returnOfCapital" is null or x.preferred is null or x.profit is null
          or x."returnOfCapital" < 0 or x.preferred < 0 or x.profit < 0
          or x."returnOfCapital" + x.preferred + x.profit <> x.amount)) then
      raise exception 'Line breakdown must be on LP lines and add to the line';
    end if;
  else raise exception 'Unknown capital operation'; end if;
  if register_state is null or linked_ids is null or cardinality(p_entry_ids) = 0 or not (linked_ids @> p_entry_ids and p_entry_ids @> linked_ids) then raise exception 'Capital operation scope or entries do not match'; end if;

  -- Freeze entry contents while checking the full partner totals, then use existing lock/balance triggers.
  -- An entity's lines are added together: its LP and carry lines both post to its one capital account.
  perform 1 from public.journal_entries where id = any(p_entry_ids) order by id for update;
  if exists (
    with expected as (
      select "lpEntityId" id, sum(amount) amount from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric) group by "lpEntityId"
    ),
    booked as (
      select a.lp_entity_id id, sum(p.amount) * capital_sign amount
      from public.journal_postings p join public.chart_of_accounts a on a.id = p.account_id
      where p.journal_entry_id = any(p_entry_ids) and p.fund_id = p_fund_id and p.vehicle_id = p_vehicle_id and p.book = 'actual'
        and a.fund_id = p_fund_id and a.vehicle_id = p_vehicle_id and a.type = 'equity' and a.subtype = 'lp_capital'
      group by a.lp_entity_id
    ) select 1 from expected full join booked using(id) where expected.amount is distinct from booked.amount
  ) then raise exception 'Recipient amounts do not match journal capital'; end if;

  if p_kind = 'call' then
    select count(*) into existing_count from public.capital_call_lines where call_id = p_register_id;
    if existing_count = 0 and register_state = 'draft' then
      insert into public.capital_call_lines(call_id, fund_id, vehicle_id, lp_entity_id, amount)
        select p_register_id, p_fund_id, p_vehicle_id, x."lpEntityId", x.amount from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric);
    elsif existing_count <> expected_count or exists (
      select 1 from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric)
      where not exists (select 1 from public.capital_call_lines l where l.call_id = p_register_id and l.fund_id = p_fund_id and l.vehicle_id = p_vehicle_id and l.lp_entity_id = x."lpEntityId" and l.amount = x.amount)
    ) then raise exception 'Recorded call recipients differ from this request'; end if;
  else
    select count(*) into existing_count from public.distribution_lines where distribution_id = p_register_id;
    if existing_count = 0 and register_state = 'draft' then
      insert into public.distribution_lines(distribution_id, fund_id, vehicle_id, lp_entity_id, amount, role, return_of_capital, preferred, profit)
        select p_register_id, p_fund_id, p_vehicle_id, x."lpEntityId", x.amount, x.role, x."returnOfCapital", x.preferred, x.profit
        from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric, role text, "returnOfCapital" numeric, preferred numeric, profit numeric);
    elsif existing_count <> expected_count or exists (
      select 1 from jsonb_to_recordset(p_lines) x("lpEntityId" uuid, amount numeric, role text)
      where not exists (select 1 from public.distribution_lines l where l.distribution_id = p_register_id and l.fund_id = p_fund_id and l.vehicle_id = p_vehicle_id and l.lp_entity_id = x."lpEntityId" and l.amount = x.amount and l.role = x.role)
    ) then raise exception 'Recorded distribution recipients differ from this request'; end if;
  end if;
  if register_state = 'draft' then
    perform public.finalize_capital_operation(p_fund_id, p_vehicle_id, p_kind, p_register_id, p_entry_ids);
  elsif (p_kind = 'call' and register_state <> 'issued') or (p_kind = 'distribution' and register_state <> 'declared') then
    raise exception 'Capital operation cannot be published in this state';
  end if;
end;
$$;
revoke all on function public.complete_capital_operation(uuid, uuid, text, uuid, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.complete_capital_operation(uuid, uuid, text, uuid, uuid[], jsonb) to service_role;
