-- A report shared with investors is locked.
--
-- The portal reads a shared report's figures LIVE from lp_investments (there is no stored copy),
-- so editing a row after sharing silently changed what an investor had already been shown. Now a
-- row in a shared report cannot have its figures changed or be deleted, and the report itself
-- cannot be deleted or re-dated. To correct one, unshare it (recorded in accounting_audit_events)
-- or publish a new report.
--
-- Figures only: a change to which entity a row points at (an LP-entity merge) or to the vehicle's
-- name (a rename relabels every row) still goes through.
-- Cascades — deleting the LP entity or a report nobody can see — are one trigger level down and
-- pass.

create or replace function public.lp_report_is_shared(p_snapshot_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_snapshot_id is not null
     and exists (select 1 from public.lp_snapshot_shares s where s.snapshot_id = p_snapshot_id)
$$;
revoke execute on function public.lp_report_is_shared(uuid) from anon, authenticated, public;

create or replace function public.lp_investments_locked_when_shared()
returns trigger language plpgsql set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if public.lp_report_is_shared(old.snapshot_id) then
      raise exception 'This position is in a report shared with investors. Unshare the report before deleting it.';
    end if;
    return old;
  end if;
  if public.lp_report_is_shared(old.snapshot_id) and (
       new.snapshot_id is distinct from old.snapshot_id
    or new.commitment is distinct from old.commitment
    or new.paid_in_capital is distinct from old.paid_in_capital
    or new.distributions is distinct from old.distributions
    or new.nav is distinct from old.nav
    or new.called_capital is distinct from old.called_capital
    or new.total_value is distinct from old.total_value
    or new.outstanding_balance is distinct from old.outstanding_balance
    or new.dpi is distinct from old.dpi
    or new.rvpi is distinct from old.rvpi
    or new.tvpi is distinct from old.tvpi
    or new.irr is distinct from old.irr
  ) then
    raise exception 'This position is in a report shared with investors. Unshare the report before changing its figures.';
  end if;
  return new;
end $$;

drop trigger if exists lp_investments_locked_when_shared on public.lp_investments;
create trigger lp_investments_locked_when_shared
  before update or delete on public.lp_investments
  for each row execute function public.lp_investments_locked_when_shared();

create or replace function public.lp_snapshots_locked_when_shared()
returns trigger language plpgsql set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if public.lp_report_is_shared(old.id) then
      raise exception 'This report is shared with investors. Unshare it before deleting it.';
    end if;
    return old;
  end if;
  if public.lp_report_is_shared(old.id) and (
       new.as_of_date is distinct from old.as_of_date
    or new.associates_calc_enabled is distinct from old.associates_calc_enabled
  ) then
    raise exception 'This report is shared with investors. Unshare it before changing its date or calculation.';
  end if;
  return new;
end $$;

drop trigger if exists lp_snapshots_locked_when_shared on public.lp_snapshots;
create trigger lp_snapshots_locked_when_shared
  before update or delete on public.lp_snapshots
  for each row execute function public.lp_snapshots_locked_when_shared();
