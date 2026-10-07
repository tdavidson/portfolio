-- Companies linked to NO entity once 20261007100100_company_vehicles.sql has run: admins see them,
-- members do not. Run in the Supabase SQL editor after pushing, and assign each to an entity (name a
-- fund on the company) so the members who work on it keep seeing it. Read-only.
select f.id as fund_id, c.id as company_id, c.name, c.holding_type, c.status, c.portfolio_group
  from public.companies c
  join public.funds f on f.id = c.fund_id
 where not exists (select 1 from public.company_vehicles cv where cv.company_id = c.id)
 order by f.id, c.name;
