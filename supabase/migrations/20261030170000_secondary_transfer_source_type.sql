-- A transfer between partners is now one of two kinds, told apart by source_type:
--   'transfer'           an assignment (gift, estate, affiliate): the new holder takes over the
--                        old holder's history for IRR. Every existing transfer stays this kind.
--   'secondary_transfer' a secondary sale: the seller's exit and the buyer's purchase at the
--                        value moved.
-- journal_entries.source_type is unconstrained; lp_capital_events checks its list, so it needs
-- the new value.

alter table public.lp_capital_events drop constraint if exists lp_capital_events_source_type_check;
alter table public.lp_capital_events add constraint lp_capital_events_source_type_check check (source_type in (
  'opening_balance',
  'capital_call', 'contribution',
  'distribution',
  'management_fee',
  'partnership_expense', 'organizational_expense',
  'income',
  'realized_gain',
  'valuation',
  'fx_revaluation',
  'transfer',
  'secondary_transfer',
  'carried_interest',
  'manual'
));
