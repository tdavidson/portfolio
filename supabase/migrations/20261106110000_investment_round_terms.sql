-- Round terms on investment transactions (lib/portfolio/round-terms.ts).
--
-- The terms of the financing an investment was made in: the round's size, its valuation or cap
-- (and which), the lead, the security, a SAFE or note's discount, and the fund's rights. An
-- investor letter's "New investments" section states them; the books had nowhere to keep them.
-- Descriptive only: nothing reads them into the ledger, a mark or a return. Members already read
-- and write investment_transactions through the existing grants and policies; a new column follows
-- the table's.
--
-- Additive.

alter table public.investment_transactions add column if not exists round_terms jsonb;

comment on column public.investment_transactions.round_terms is
  'Terms of the financing round: round_size, valuation, valuation_basis (pre_money | post_money | cap), currency, lead, security, discount_pct, rights, notes. Descriptive only.';
