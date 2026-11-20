-- Records becomes its own access right.
--
-- Fund records (20261101140000_fund_records.sql) were open to any member who could read some area
-- of the fund, and filing one needed only read. The new `records` domain sits above that: read on
-- it to list and open records, write on it to file one. The area check still applies underneath
-- (lib/records/areas.ts), so a record is still shown only to someone who reads its area and sees its
-- entity. See DOMAIN_META.records in lib/access/domains.ts.
--
-- Members start without it: every fund's default for `records` is 'none', and an admin grants it per
-- person in the access grid (or changes the fund default). Admins always have it. This is also what
-- the app does before this is applied, since `records` has no defaultFrom.

--
-- `fund_records` is service-role only, so no RLS policy reads this domain, and it has no fund-level
-- switch, so domain_primary_feature() needs no change (its `else null` arm covers it).

-- 1. Every existing fund's default.
insert into public.fund_domain_defaults (fund_id, domain, level)
select f.id, 'records', 'none'
from funds f
on conflict (fund_id, domain) do nothing;

-- 2. New funds. Restated in full (it is a `create or replace`) from 20261012150000_tax_domain.sql,
--    with `records` added.
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
    -- Granted per person, never by default: the firm's own books (including payroll), and records.
    ('management_company', 'none'), ('records', 'none')
  ) as d(domain, level)
  on conflict (fund_id, domain) do nothing;
  return new;
end;
$$;

revoke execute on function public.seed_fund_domain_defaults() from public, anon, authenticated;
