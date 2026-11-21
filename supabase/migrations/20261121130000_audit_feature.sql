-- Records becomes Audit: an automatic log of what outside firms do, behind its own fund switch.
--
-- Records (20261101140000_fund_records.sql) only held what someone filed by hand, so it stayed
-- empty. Audit is read from what the app already writes (the books' audit trail, the activity log,
-- the MCP/API connect entries) for every member ever on an engagement, plus a `web.change` activity
-- row the proxy writes for an outside firm's change in the web app. See lib/audit-log/index.ts.
--
-- 1. A fund switch, `audit`, in the same Feature visibility controls as every other feature: off
--    by default (nothing extra is written and nobody sees it), "Members" or "Admins only" when on.
-- 2. The `records` grant keeps its key and becomes the per-person narrowing under that switch.
--    Members now start at write (see the log, file a note into it), so "Members" on the switch means
--    members; an admin can still lower anyone in the access grid.
--
-- No new table. fund_records stays as it is and its notes show inside each firm's log.

-- 1. feature_default(): restated in full from 20261121120000_inbound_switch_and_own_approvals.sql, with
--    `audit` added. Mirrors DEFAULT_FEATURE_VISIBILITY (tests/rls-domain-policies.test.ts).
create or replace function public.feature_default(p_feature text)
returns text
language sql
immutable
parallel safe
as $$
  select case p_feature
    when 'interactions'       then 'off'
    when 'investments'        then 'everyone'
    when 'notes'              then 'off'
    when 'lp_letters'         then 'off'
    when 'imports'            then 'everyone'
    when 'asks'               then 'admin'
    when 'inbound'            then 'everyone'
    when 'lps'                then 'off'
    when 'lp_tracking'        then 'off'
    when 'lp_portal'          then 'off'
    when 'lp_activity'        then 'off'
    when 'compliance'         then 'off'
    when 'deals'              then 'off'
    when 'diligence'          then 'off'
    when 'accounting'         then 'off'
    when 'gp_economics'       then 'off'
    when 'tax_reporting'      then 'off'
    when 'management_company' then 'off'
    when 'audit'              then 'off'
    -- An unknown key is not a reason to open a door.
    else 'off'
  end;
$$;

-- 2. domain_primary_feature(): restated in full from 20261012150000_tax_domain.sql, with
--    `records` → `audit`. Mirrors DOMAIN_META.primaryFeature.
create or replace function public.domain_primary_feature(p_domain text)
returns text
language sql
immutable
parallel safe
as $$
  select case p_domain
    when 'dealflow'           then 'deals'
    when 'diligence'          then 'diligence'
    when 'accounting'         then 'accounting'
    when 'management_company' then 'management_company'
    when 'lp_capital'         then 'lps'
    when 'gp_economics'       then 'gp_economics'
    when 'compliance'         then 'compliance'
    when 'tax'                then 'tax_reporting'
    when 'records'            then 'audit'
    else null
  end;
$$;

-- 3. Every fund's member default for `records` is write. Safe to widen: the `audit` switch above
--    is off for every fund until an admin turns it on.
insert into public.fund_domain_defaults (fund_id, domain, level)
select f.id, 'records', 'write'
from funds f
on conflict (fund_id, domain) do update set level = 'write';

-- 4. Explicit `none` grants on `records` came from the presets, which until now always wrote none
--    there. Drop them so those members follow the fund default; an admin can set one again.
delete from public.fund_member_access where domain = 'records' and level = 'none';

-- 5. New funds. Restated in full from 20261120230000_records_access_right.sql, with `records` at
--    write.
create or replace function public.seed_fund_domain_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.fund_domain_defaults (fund_id, domain, level)
  select new.id, d.domain, d.level
  from (values
    ('portfolio', 'write'), ('relationships', 'write'), ('dealflow', 'write'),
    ('diligence', 'write'), ('accounting', 'write'), ('lp_capital', 'write'),
    ('gp_economics', 'write'), ('lp_relations', 'write'), ('compliance', 'write'),
    ('tax', 'write'),
    -- Audit: under its own fund switch, which starts off.
    ('records', 'write'),
    -- Granted per person, never by default: the firm's own books, including payroll.
    ('management_company', 'none')
  ) as d(domain, level)
  on conflict (fund_id, domain) do nothing;
  return new;
end;
$$;

revoke execute on function public.seed_fund_domain_defaults() from public, anon, authenticated;
