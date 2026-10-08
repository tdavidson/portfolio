-- supabase/migrations/20261008100001_valuation_change_source_quote_nav.sql
--
-- A valuation change can come from a quoted price (a price feed) or a fund manager's NAV
-- statement, as well as a hand mark or a rate move. The check allowed only 'mark' and 'fx'
-- (20260710000001_investment_fx_revaluation.sql), so every quoted-mark insert from
-- app/api/accounting/quote-marks has been failing it. Drop and re-add, guarded so a re-run is safe.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'investment_transactions_valuation_change_source_check'
      and conrelid = 'public.investment_transactions'::regclass
  ) then
    alter table public.investment_transactions
      drop constraint investment_transactions_valuation_change_source_check;
  end if;
end $$;

alter table public.investment_transactions
  add constraint investment_transactions_valuation_change_source_check
  check (valuation_change_source is null or valuation_change_source in ('mark', 'fx', 'quote', 'nav'));
