-- An administrator-stated position can carry the carried interest within the partner's account
-- (Carta's "Carried interest accrued" bucket: positive on the GP's row, negative where it is charged
-- to an LP). Splitting a GP/associate row across its own members uses it to tell the associate's
-- own capital return, which follows ownership, from its carry, which follows carry points.
alter table public.lp_positions
  add column if not exists carried_interest numeric;
