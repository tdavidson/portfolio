-- Tag postings on a partner's own capital account that were written without a partner.
--
-- A capital account that belongs to one partner (chart_of_accounts.lp_entity_id set) can only
-- ever hold that partner's capital, but manual entries written before the posting path learned to
-- inherit the account's partner (inheritAccountPartner in lib/accounting/persist.ts) left
-- lp_entity_id null on those lines. Per-partner reports, closes and statements group capital by
-- the posting's lp_entity_id, so those contributions were missing from the partner's figures while
-- still counting in the vehicle's totals.
--
-- This copies the account's partner onto every such posting in a posted entry. It moves no money:
-- the account and amount are unchanged, only the partner label is filled in. Many of these lines
-- sit in closed periods, so it uses the same transaction-local flag as merge_lp_entities, which
-- lets the period lock pass an update that changes lp_entity_id and nothing else.

select set_config('hemrock.merging_lp_entity', 'on', true);

update public.journal_postings jp
set lp_entity_id = ca.lp_entity_id
from public.chart_of_accounts ca, public.journal_entries je
where ca.id = jp.account_id
  and je.id = jp.journal_entry_id
  and je.status = 'posted'
  and jp.lp_entity_id is null
  and ca.lp_entity_id is not null;

select set_config('hemrock.merging_lp_entity', 'off', true);
