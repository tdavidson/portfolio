-- Bank entries whose source type contradicts the account they post to.
--
-- When the bank import recognised nothing, an inflow fell back to members' / LP capital and its
-- draft entry was a capital call. Re-pointing the row to an income or expense account later did not
-- always change the source type (fixed for the bank page and agent re-point on 2026-10-14, and at
-- posting time from this release). Those entries carry the right amounts on the right accounts but
-- are labelled capital calls, so anything that groups or filters by source type counted them as one.
--
-- This relabels them by rule; no amounts, accounts or statuses change. An entry is corrected when:
--   * it is on the actual book, not void, and a bank transaction points at it;
--   * its source type is capital_call or distribution;
--   * every line that is not cash posts to an income or expense account, and those accounts all
--     imply the same source type (the same mapping as sourceTypeForAccount in
--     lib/accounting/bank-categorize.ts: management_fee and organizational_expense subtypes keep
--     their own type, other income is 'income', other expenses 'partnership_expense');
--   * its date is not in a closed fiscal period. The period lock refuses any change there. Reopen
--     the period and paste this again to include those entries; re-running is safe.

begin;

with candidate as (
  select je.id,
         min(case
               when a.subtype = 'management_fee' then 'management_fee'
               when a.subtype = 'organizational_expense' then 'organizational_expense'
               when a.type = 'income' then 'income'
               else 'partnership_expense'
             end) as target,
         count(distinct case
               when a.subtype = 'management_fee' then 'management_fee'
               when a.subtype = 'organizational_expense' then 'organizational_expense'
               when a.type = 'income' then 'income'
               else 'partnership_expense'
             end) as targets,
         bool_and(a.type in ('income', 'expense')) as all_pnl
  from public.journal_entries je
  join public.journal_postings jp on jp.journal_entry_id = je.id and jp.book = je.book
  join public.chart_of_accounts a on a.id = jp.account_id
  where je.book = 'actual'
    and je.status <> 'void'
    and je.source_type in ('capital_call', 'distribution')
    and exists (select 1 from public.bank_transactions bt where bt.journal_entry_id = je.id)
    and not (a.code = '1000' or coalesce(a.subtype, '') = 'cash')
    and not exists (
      select 1 from public.fiscal_periods fp
      where fp.fund_id = je.fund_id
        and fp.vehicle_id is not distinct from je.vehicle_id
        and fp.status = 'closed'
        and je.entry_date between fp.period_start and fp.period_end
    )
  group by je.id
)
update public.journal_entries je
set source_type = c.target
from candidate c
where je.id = c.id
  and c.all_pnl
  and c.targets = 1;

commit;

-- What is left: bank entries still labelled as capital movements on income or expense accounts,
-- by whether a closed period holds them. Expect only closed-period rows here.
select je.portfolio_group,
       exists (
         select 1 from public.fiscal_periods fp
         where fp.fund_id = je.fund_id
           and fp.vehicle_id is not distinct from je.vehicle_id
           and fp.status = 'closed'
           and je.entry_date between fp.period_start and fp.period_end
       ) as in_closed_period,
       count(*) as entries
from public.journal_entries je
where je.book = 'actual'
  and je.status <> 'void'
  and je.source_type in ('capital_call', 'distribution')
  and exists (select 1 from public.bank_transactions bt where bt.journal_entry_id = je.id)
  and exists (
    select 1 from public.journal_postings jp
    join public.chart_of_accounts a on a.id = jp.account_id
    where jp.journal_entry_id = je.id and jp.book = je.book and a.type in ('income', 'expense')
  )
group by 1, 2
order by 1, 2;
