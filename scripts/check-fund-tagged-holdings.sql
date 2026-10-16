-- Read-only, one statement. Paste into the Supabase SQL editor.
--
-- WHY: `loadFofActive` (lib/portfolio/fof.ts) switches the entire fund-of-funds feature set on
-- when ANY company has holding_type = 'fund' — it is derived from the data, not a setting. So a
-- handful of dormant rows turn on "Underlying funds" and "Quarterly close (funds)" for the whole
-- firm, and (before it was deleted) listed themselves as zero-figure rows on every entity's
-- fund-of-funds report.
--
-- This lists every fund-tagged holding with what is actually attached to it, so you can tell a
-- real position from a name somebody typed once. The last column mirrors what the DELETE route
-- refuses on, so it says whether a holding can simply be removed.

select
  c.name                                                        as holding,
  coalesce(t.commitment, 0)                                     as commitment,
  (select count(*) from public.fund_capital_events e
    where e.company_id = c.id)                                  as capital_events,
  (select count(*) from public.fund_nav_statements n
    where n.company_id = c.id)                                  as nav_statements,
  (select count(*) from public.investment_transactions x
    where x.company_id = c.id)                                  as investment_txns,
  (select count(*) from public.chart_of_accounts a
    where a.company_id = c.id)                                  as ledger_accounts,
  (select count(*) from public.journal_postings p
    join public.chart_of_accounts a2 on a2.id = p.account_id
   where a2.company_id = c.id)                                  as ledger_postings,
  case
    when exists (select 1 from public.fund_capital_events e
                  where e.company_id = c.id and e.investment_transaction_id is not null)
      or exists (select 1 from public.fund_nav_statements n
                  where n.company_id = c.id and n.investment_transaction_id is not null)
      then 'NO - posted to the ledger; reverse those entries first'
    when exists (select 1 from public.journal_postings p
                  join public.chart_of_accounts a3 on a3.id = p.account_id
                 where a3.company_id = c.id)
      then 'CAREFUL - no register activity, but its ledger accounts carry postings'
    when exists (select 1 from public.investment_transactions x where x.company_id = c.id)
      then 'CAREFUL - has investment transactions'
    else 'YES - nothing attached'
  end                                                           as safe_to_delete
  from public.companies c
  left join public.fund_holding_terms t on t.company_id = c.id
 where c.fund_id = (select fund_id from public.companies where holding_type = 'fund' limit 1)
   and c.holding_type = 'fund'
 order by 8 desc, c.name;

-- If a row says 'YES - nothing attached' it is a name with no data behind it. Removing all of
-- them switches the fund-of-funds surfaces off, which is the honest state for a firm with an
-- empty register. Delete from the Underlying funds page so the route's checks run, or by hand:
--
--   delete from public.companies where id = '<the holding id>';
--
-- Re-tagging is the other option where the thing is not a fund at all (an exchange or operating
-- company tagged as a fund): update public.companies set holding_type = 'company' where id = '<id>';
