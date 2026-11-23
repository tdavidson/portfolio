-- Merge one LP legal entity into another.
--
-- The same subscriber can end up as two entities (one created per import, spelled differently),
-- each holding positions in different vehicles. lp_delete_entity rightly refuses an entity with
-- money on the books, and merging investors only moves entities between investors, so there was no
-- way to make the two one.
--
-- This re-keys every row that references `p_from` (every foreign key to lp_entities.id, found from
-- the catalog so a table added later is covered too) to `p_into`, renames `p_from`'s per-LP capital
-- accounts to `p_into`'s code where that code is free, and deletes `p_from`. It runs as one
-- statement, so it applies whole or not at all: where both entities hold a row a unique key allows
-- only once (a position in the same vehicle), the update fails and nothing changes.
--
-- Only the service role calls it (lib/lps/records.ts, behind the admin-only staged tool).
--
-- Closed periods. assert_posting_period_open refuses ANY change to a posting in a closed period,
-- and a merged partner's postings are usually there. Re-pointing a posting from one record of the
-- same subscriber to another moves no money and changes no balance a close produced, so the lock
-- lets exactly that through, and only inside this function: it sets a transaction-local flag, and
-- the trigger passes an update only when the flag is on AND nothing but lp_entity_id changed.

create or replace function public.assert_posting_period_open()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_fund uuid; v_vehicle uuid; v_date date; v_book text;
begin
  if tg_op = 'UPDATE'
     and current_setting('hemrock.merging_lp_entity', true) = 'on'
     and (to_jsonb(new) - 'lp_entity_id') = (to_jsonb(old) - 'lp_entity_id') then
    return new;
  end if;

  select je.fund_id, je.vehicle_id, je.entry_date, je.book
    into v_fund, v_vehicle, v_date, v_book
  from public.journal_entries je
  where je.id = coalesce(new.journal_entry_id, old.journal_entry_id);

  if coalesce(v_book, 'actual') = 'actual' then
    perform public.assert_period_open_for(v_fund, v_vehicle, v_date);
  else
    perform public.assert_tax_year_open_for(v_fund, v_vehicle, v_date);
  end if;

  return coalesce(new, old);
end;
$$;

create or replace function public.merge_lp_entities(p_fund_id uuid, p_from uuid, p_into uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  fk record;
  n bigint;
  moved jsonb := '{}'::jsonb;
  into_name text;
begin
  if p_from = p_into then
    raise exception 'Cannot merge an LP entity into itself';
  end if;
  if not exists (select 1 from public.lp_entities where id = p_from and fund_id = p_fund_id) then
    raise exception 'The entity to merge away is not in this fund';
  end if;
  select entity_name into into_name from public.lp_entities where id = p_into and fund_id = p_fund_id;
  if into_name is null then
    raise exception 'The entity to merge into is not in this fund';
  end if;

  -- Lets re-pointed postings in closed periods through the period lock (see above). Local to
  -- this transaction.
  perform set_config('hemrock.merging_lp_entity', 'on', true);

  -- Every single-column foreign key to lp_entities(id), wherever it lives in public.
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid = 'public.lp_entities'::regclass
       and array_length(c.conkey, 1) = 1
  loop
    execute format('update %s set %I = $1 where %I = $2', fk.tbl, fk.col, fk.col) using p_into, p_from;
    get diagnostics n = row_count;
    if n > 0 then
      moved := moved || jsonb_build_object(fk.tbl::text || '.' || fk.col, n);
    end if;
  end loop;

  -- The capital accounts that came across keep their old 3100-<from> code unless renamed. Rename
  -- each to 3100-<into> where the vehicle has no account by that code yet.
  update public.chart_of_accounts ca
     set code = '3100-' || left(p_into::text, 8),
         name = 'Partners'' capital — ' || into_name
   where ca.fund_id = p_fund_id
     and ca.lp_entity_id = p_into
     and ca.code = '3100-' || left(p_from::text, 8)
     and not exists (
       select 1 from public.chart_of_accounts o
        where o.fund_id = ca.fund_id and o.portfolio_group is not distinct from ca.portfolio_group
          and o.code = '3100-' || left(p_into::text, 8)
     );

  delete from public.lp_entities where id = p_from and fund_id = p_fund_id;
  perform set_config('hemrock.merging_lp_entity', 'off', true);

  return jsonb_build_object('moved', moved);
end;
$$;

revoke execute on function public.merge_lp_entities(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.merge_lp_entities(uuid, uuid, uuid) to service_role;
