-- supabase/migrations/20261009200000_parsing_reviews_fund_rows_service_only.sql
--
-- A manager-email FUND proposal (issue_type fund_nav, fund_capital_call, fund_distribution) is
-- approved by writing what it proposes: a NAV statement, which books a ledger mark, or a draft
-- notice (lib/portfolio/fof-reviews.ts). The proposal's worth is that it was read from the
-- manager's document — and only the email pipeline writes it, with the service role
-- (lib/portfolio/fof-email.ts). Every application write to parsing_reviews, approval and dismissal
-- included, uses the service role too.
--
-- But the table's write policies (20260903000000) need only portfolio write, so a member with that
-- and no `investments` feature could, from the browser with the anon key and their own JWT, insert
-- a "Manager NAV" proposal or rewrite a genuine one's payload — and an admin approving it would book
-- it (security scan M1). The same member could read every fund row's payload, which the routes hide
-- from anyone without the investments feature (L1).
--
-- So, for fund rows only, through the Data API:
--   * authenticated may not insert, update or delete them — the service role (which bypasses RLS)
--     is the only writer, as the application already is. A row may not be turned INTO a fund row
--     either: the update check reads the new row too.
--   * reading them needs portfolio read WITH the investments feature, as fund_nav_statements does
--     (20260903000000), through the same resolver (public.fund_ids_readable).
-- Every other review is unchanged. These are RESTRICTIVE: they narrow the existing domain policies
-- and the entity policy ("Only the caller's entities", 20261009100000), and widen nothing.
--
-- Nothing in the deployed release writes these rows with a user client (every insert, update and
-- delete of parsing_reviews goes through createAdminClient), so this needs no deploy first. Reads
-- through a user client already drop fund rows for a caller without the investments feature
-- (scopeFundReviews / fundReadable in api/review and api/emails/[id]/reviews), so a reader loses
-- nothing the routes showed.
--
-- No new table, so no grants. Re-runnable: each policy is dropped before it is created.

drop policy if exists "Fund proposals are read with investments" on public.parsing_reviews;
create policy "Fund proposals are read with investments" on public.parsing_reviews
  as restrictive for select to authenticated
  using (
    issue_type not in ('fund_nav', 'fund_capital_call', 'fund_distribution')
    or fund_id = any((select public.fund_ids_readable('portfolio', 'investments'))::uuid[])
  );

drop policy if exists "Fund proposals are not inserted through the Data API" on public.parsing_reviews;
create policy "Fund proposals are not inserted through the Data API" on public.parsing_reviews
  as restrictive for insert to authenticated
  with check (issue_type not in ('fund_nav', 'fund_capital_call', 'fund_distribution'));

drop policy if exists "Fund proposals are not updated through the Data API" on public.parsing_reviews;
create policy "Fund proposals are not updated through the Data API" on public.parsing_reviews
  as restrictive for update to authenticated
  using (issue_type not in ('fund_nav', 'fund_capital_call', 'fund_distribution'))
  with check (issue_type not in ('fund_nav', 'fund_capital_call', 'fund_distribution'));

drop policy if exists "Fund proposals are not deleted through the Data API" on public.parsing_reviews;
create policy "Fund proposals are not deleted through the Data API" on public.parsing_reviews
  as restrictive for delete to authenticated
  using (issue_type not in ('fund_nav', 'fund_capital_call', 'fund_distribution'));
