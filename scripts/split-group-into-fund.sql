-- Move one entity group out of a fund and into a new fund of its own, in the same database.
--
-- Written for splitting 3SE Holdings out of Laconia Capital Group, but nothing in it is specific to
-- either: it takes the source fund, the group's name, and the new fund's name and email domain.
--
--   psql "$DATABASE_URL" -f scripts/split-group-into-fund.sql \
--     -v source_fund=957a17f7-ddeb-4705-a6c8-d722f8cedc3c \
--     -v group_name='3SE Holdings' -v fund_name='3SE Holdings' -v email_domain=3seholdings.com \
--     [-v admin_email=someone@3seholdings.com] [-v apply=1]
--
-- Without `-v apply=1` it is a DRY RUN: everything happens inside one transaction, the summary and
-- the safety checks print, and the transaction rolls back. Run it that way first and read the
-- output. With `-v apply=1` the same transaction commits.
--
-- This is a one-off data operation, NOT a migration: it names rows that exist only in one
-- deployment, so it must never live in supabase/migrations/ (a fresh install would run it).
--
-- What moves (fund_id is rewritten; ids never change, so every link between moved rows holds):
--   * the group and its entities (fund_vehicles);
--   * every row of every table with a foreign key to one of those entities — the ledger, chart,
--     bank feed, capital, allocations, documents, QuickBooks mappings, pending actions, …;
--   * the companies held only by those entities, and every row of every table keyed by
--     company_id (investment transactions, metrics, updates, notes, emails, …);
--   * rows tagged by name (portfolio_group) with one of the entities' names or aliases;
--   * the authorized senders at the new fund's email domain.
--
-- What is shared, and so is COPIED rather than moved:
--   * an LP investor, LP entity or vendor that both funds use. The new fund gets its own copy and
--     its rows are pointed at the copy; the source fund keeps the original untouched. One that
--     only the moved rows use is moved instead. An LP's portal login is linked to the copy too, so
--     they still see these entities in the portal.
--   * an LP report holding positions in both funds' entities. The new fund gets a report of the same
--     name with the group's positions. If the original is shared with investors it is left exactly
--     as it was (positions in a shared report cannot change); otherwise the group's positions move
--     into the copy.
--
-- What does not move: the source fund's settings, API keys, Google Drive, email routing and members.
-- The new fund gets a fresh settings row (no keys, no Drive; the app mints the fund's encryption
-- key the first time a credential is saved) with the source fund's feature switches, currency and
-- lot method, so the moved books open and compute the same way.
--
-- Uploaded files keep their storage path. Paths start with the old fund's id, which only matters
-- when a client hands a path back at upload time (pathBelongsTo); reads use the stored path.
--
-- The last step checks every single-column foreign key between two fund-scoped tables and fails
-- the whole transaction if any row points across the two funds. Anything this script missed
-- aborts the run instead of leaving a half-split database.

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif
\if :{?admin_email}
\else
  \set admin_email ''
\endif

begin;

create temp table split_params on commit drop as
select :'source_fund'::uuid as source_fund,
       :'group_name'::text as group_name,
       :'fund_name'::text as fund_name,
       lower(:'email_domain')::text as email_domain,
       nullif(lower(:'admin_email'), '')::text as admin_email;

-- Single-column foreign keys in public, with whether each end carries fund_id.
create temp view split_fks as
select c.oid as con,
       c.conrelid::regclass as src, a.attname::text as col,
       c.confrelid::regclass as dst, fa.attname::text as dcol,
       c.confdeltype as deltype,
       exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'fund_id' and not x.attisdropped) as src_has_fund,
       exists (select 1 from pg_attribute x where x.attrelid = c.confrelid and x.attname = 'fund_id' and not x.attisdropped) as dst_has_fund
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
  join pg_attribute fa on fa.attrelid = c.confrelid and fa.attnum = c.confkey[1]
 where c.contype = 'f' and cardinality(c.conkey) = 1
   and c.connamespace = 'public'::regnamespace
   and c.confrelid::regclass::text <> 'funds';

create temp table split_summary (step int, tbl text, action text, n bigint) on commit drop;
create temp table split_map (kind text, old_id uuid, new_id uuid, primary key (kind, old_id)) on commit drop;

do $split$
declare
  p          record;
  v_src      uuid;
  v_new      uuid;
  v_group    uuid;
  v_vids     uuid[];
  v_names    text[];
  v_cids     uuid[];
  v_creator  uuid;
  v_admin    uuid;
  r          record;
  t          record;
  n          bigint;
  v_pred     text;
  v_sql      text;
  v_bad      text;
  v_snap     uuid;
  v_moved    bigint;
begin
  select * into p from split_params;
  v_src := p.source_fund;

  ------------------------------------------------------------------------------------------------
  -- 0. What is moving, and is it safe to start?
  ------------------------------------------------------------------------------------------------
  if not exists (select 1 from funds where id = v_src) then
    raise exception 'No fund %', v_src;
  end if;
  select id into v_group from vehicle_groups where fund_id = v_src and lower(btrim(name)) = lower(btrim(p.group_name));
  if v_group is null then
    raise exception 'Fund % has no entity group called "%"', v_src, p.group_name;
  end if;
  select array_agg(id) into v_vids from fund_vehicles where fund_id = v_src and group_id = v_group;
  select array_agg(distinct nm) into v_names
    from fund_vehicles v, unnest(array[v.name] || coalesce(v.aliases, '{}')) nm
   where v.id = any(v_vids);
  if v_vids is null then
    raise exception 'The group "%" has no entities', p.group_name;
  end if;
  if exists (select 1 from funds where lower(btrim(name)) = lower(btrim(p.fund_name))) then
    raise exception 'A fund called "%" already exists', p.fund_name;
  end if;

  for r in select id, name from fund_vehicles where id = any(v_vids) order by name loop
    raise notice 'entity moving: % (%)', r.name, r.id;
  end loop;

  -- An entity of the group that serves, or is served by, one outside it cannot be split off.
  if exists (select 1 from fund_vehicles where fund_id = v_src and (
              (id = any(v_vids) and serves_vehicle_id is not null and not serves_vehicle_id = any(v_vids))
           or (not id = any(v_vids) and serves_vehicle_id = any(v_vids)))) then
    raise exception 'An entity in "%" serves, or is served by, an entity outside it', p.group_name;
  end if;
  -- Rows that link a group entity to an entity outside it (intercompany, invoices, GP links, …).
  for r in select src, array_agg(col) cols from split_fks where dst = 'fund_vehicles'::regclass group by src having count(*) > 1 loop
    v_sql := format('select count(*) from %s where fund_id = $1 and (%s) and not (%s)', r.src,
      (select string_agg(format('%I = any($2)', c), ' or ') from unnest(r.cols) c),
      (select string_agg(format('coalesce(%I = any($2), true)', c), ' and ') from unnest(r.cols) c));
    execute v_sql into n using v_src, v_vids;
    if n > 0 then
      raise exception '% row(s) in % link an entity in "%" to one outside it', n, r.src, p.group_name;
    end if;
  end loop;
  -- Members restricted to particular entities: the restriction would point across funds.
  if exists (select 1 from fund_member_vehicles where fund_id = v_src and vehicle_id = any(v_vids)) then
    raise exception 'Some members of the source fund are restricted to entities in "%"; remove those grants first', p.group_name;
  end if;

  -- Companies held only by the group's entities. One held by both sides cannot be split.
  select array_agg(c.id) into v_cids
    from companies c
   where c.fund_id = v_src
     and (exists (select 1 from company_vehicles cv where cv.company_id = c.id and cv.vehicle_id = any(v_vids))
          or (not exists (select 1 from company_vehicles cv where cv.company_id = c.id)
              and cardinality(c.portfolio_group) > 0 and c.portfolio_group <@ v_names));
  select string_agg(c.name, ', ') into v_bad
    from companies c
   where c.id = any(coalesce(v_cids, '{}'))
     and (exists (select 1 from company_vehicles cv where cv.company_id = c.id and not cv.vehicle_id = any(v_vids))
          or exists (select 1 from unnest(c.portfolio_group) g
                      join fund_vehicles v on v.fund_id = v_src and not v.id = any(v_vids)
                                          and (v.name = g or g = any(v.aliases))));
  if v_bad is not null then
    raise exception 'These companies are held by entities on both sides and cannot be split: %', v_bad;
  end if;
  v_cids := coalesce(v_cids, '{}');

  ------------------------------------------------------------------------------------------------
  -- 1. The new fund and its settings.
  ------------------------------------------------------------------------------------------------
  -- created_by is the source fund's creator (whoever is splitting it). funds' creator trigger would
  -- also make them the new fund's admin, but a person belongs to one fund only, so it is off for this
  -- insert and the new fund's admin (if named) is added below.
  alter table funds disable trigger fund_creator_member;
  insert into funds (name, created_by, email_domain)
  select p.fund_name, f.created_by, p.email_domain from funds f where f.id = v_src
  returning id into v_new;
  alter table funds enable trigger fund_creator_member;
  -- funds.currency exists on some deployments and not others.
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'funds' and column_name = 'currency') then
    execute 'update funds n set currency = s.currency from funds s where n.id = $1 and s.id = $2' using v_new, v_src;
  end if;
  insert into split_summary values (1, 'funds', 'created ' || v_new, 1);
  raise notice 'new fund: % (%)', p.fund_name, v_new;

  insert into fund_settings (fund_id, feature_visibility, currency, lot_method)
  select v_new, s.feature_visibility, s.currency, s.lot_method from fund_settings s where s.fund_id = v_src;
  if not found then
    insert into fund_settings (fund_id) values (v_new);
  end if;
  insert into split_summary values (1, 'fund_settings', 'created (no keys, no Drive)', 1);

  insert into allowed_signups (email_pattern) values ('*@' || p.email_domain) on conflict do nothing;
  get diagnostics n = row_count;
  insert into split_summary values (1, 'allowed_signups', '*@' || p.email_domain, n);

  if p.admin_email is not null then
    select id into v_admin from auth.users where lower(email) = p.admin_email;
    if v_admin is null then
      raise exception 'No account for % — have them sign up first, or leave admin_email out', p.admin_email;
    end if;
    if exists (select 1 from fund_members where user_id = v_admin) then
      raise exception '% already belongs to a fund', p.admin_email;
    end if;
    insert into fund_members (fund_id, user_id, role) values (v_new, v_admin, 'admin');
    insert into split_summary values (1, 'fund_members', 'admin ' || p.admin_email, 1);
  end if;

  ------------------------------------------------------------------------------------------------
  -- 2. Move the group, its entities, and everything keyed to them.
  ------------------------------------------------------------------------------------------------
  -- Order matters only for triggers: entities before companies (company links resolve entity names
  -- within the company's fund), investment transactions before journal entries, entries before
  -- postings (the posting checks read the entry's fund).
  update vehicle_groups set fund_id = v_new where id = v_group;
  update fund_vehicles set fund_id = v_new where id = any(v_vids);
  get diagnostics n = row_count;
  insert into split_summary values (2, 'fund_vehicles', 'moved', n);
  update companies set fund_id = v_new where id = any(v_cids);
  get diagnostics n = row_count;
  insert into split_summary values (2, 'companies', 'moved', n);
  update investment_transactions set fund_id = v_new
   where fund_id = v_src and (company_id = any(v_cids) or portfolio_group = any(v_names));
  get diagnostics n = row_count;
  insert into split_summary values (2, 'investment_transactions', 'moved', n);
  update journal_entries set fund_id = v_new where fund_id = v_src and vehicle_id = any(v_vids);
  get diagnostics n = row_count;
  insert into split_summary values (2, 'journal_entries', 'moved', n);

  -- Every table with a foreign key to fund_vehicles. fund_settings is the source fund's own row.
  for r in select src, string_agg(format('%I = any($2)', col), ' or ') pred
             from split_fks
            where dst = 'fund_vehicles'::regclass and src_has_fund
              and src not in ('fund_settings'::regclass, 'fund_vehicles'::regclass)
            group by src order by src::text loop
    execute format('update %s set fund_id = $3 where fund_id = $1 and (%s)', r.src, r.pred) using v_src, v_vids, v_new;
    get diagnostics n = row_count;
    if n > 0 then insert into split_summary values (2, r.src::text, 'moved (by entity)', n); end if;
  end loop;

  -- Every table keyed by company_id.
  for r in select c.table_name::text tbl
             from information_schema.columns c
            where c.table_schema = 'public' and c.column_name = 'company_id'
              and c.table_name <> 'companies'
              and exists (select 1 from information_schema.columns f where f.table_schema = 'public'
                            and f.table_name = c.table_name and f.column_name = 'fund_id')
              and exists (select 1 from information_schema.tables x where x.table_schema = 'public'
                            and x.table_name = c.table_name and x.table_type = 'BASE TABLE')
            order by 1 loop
    execute format('update public.%I set fund_id = $3 where fund_id = $1 and company_id = any($2)', r.tbl) using v_src, v_cids, v_new;
    get diagnostics n = row_count;
    if n > 0 then insert into split_summary values (2, r.tbl, 'moved (by company)', n); end if;
  end loop;

  -- Rows that name an entity rather than point at it. lp_investments are LP report positions,
  -- handled with their reports in step 3.
  for r in select c.table_name::text tbl
             from information_schema.columns c
            where c.table_schema = 'public' and c.column_name = 'portfolio_group' and c.data_type = 'text'
              and c.table_name <> 'lp_investments'
              and exists (select 1 from information_schema.columns f where f.table_schema = 'public'
                            and f.table_name = c.table_name and f.column_name = 'fund_id')
              and exists (select 1 from information_schema.tables x where x.table_schema = 'public'
                            and x.table_name = c.table_name and x.table_type = 'BASE TABLE')
            order by 1 loop
    execute format('update public.%I set fund_id = $3 where fund_id = $1 and portfolio_group = any($2)', r.tbl) using v_src, v_names, v_new;
    get diagnostics n = row_count;
    if n > 0 then insert into split_summary values (2, r.tbl, 'moved (by entity name)', n); end if;
  end loop;

  -- Children of moved rows that carry neither an entity nor a company (an email's parsing reviews,
  -- an update's chunks, …): a row whose ON DELETE CASCADE foreign key points at a moved row belongs
  -- to it, so it follows — repeatedly, until nothing more moves. LP investors, entities, vendors and
  -- reports are decided in steps 3 and 4, not here. Any other reference that ends up crossing the
  -- two funds is caught by the checks in step 5.
  loop
    v_moved := 0;
    for r in select * from split_fks
              where src_has_fund and dst_has_fund and deltype = 'c'
                and dst::text not in ('lp_entities', 'lp_investors', 'vendors', 'lp_snapshots', 'lp_investments')
                and src::text not in ('fund_settings', 'lp_investments') loop
      execute format('update %s s set fund_id = $2 from %s d where d.%I = s.%I and s.fund_id = $1 and d.fund_id = $2',
                     r.src, r.dst, r.dcol, r.col) using v_src, v_new;
      get diagnostics n = row_count;
      if n > 0 then
        insert into split_summary values (2, r.src::text, 'moved (with its ' || r.dst::text || ')', n);
        v_moved := v_moved + n;
      end if;
    end loop;
    exit when v_moved = 0;
  end loop;

  update authorized_senders set fund_id = v_new
   where fund_id = v_src and lower(split_part(email, '@', 2)) = p.email_domain;
  get diagnostics n = row_count;
  insert into split_summary values (2, 'authorized_senders', 'moved (@' || p.email_domain || ')', n);

  -- The source fund's own settings must stop pointing at moved entities.
  update fund_settings
     set deals_default_vehicle_id = case when deals_default_vehicle_id = any(v_vids) then null else deals_default_vehicle_id end,
         dashboard_excluded_vehicle_ids = (select coalesce(array_agg(x), '{}') from unnest(dashboard_excluded_vehicle_ids) x where not x = any(v_vids))
   where fund_id = v_src
     and (deals_default_vehicle_id = any(v_vids) or dashboard_excluded_vehicle_ids && v_vids);

  ------------------------------------------------------------------------------------------------
  -- 3. LP reports.
  ------------------------------------------------------------------------------------------------
  for r in select s.id, s.name, public.lp_report_is_shared(s.id) shared,
                  bool_and(i.portfolio_group = any(v_names)) only_group
             from lp_snapshots s join lp_investments i on i.snapshot_id = s.id
            where s.fund_id = v_src
            group by s.id
           having bool_or(i.portfolio_group = any(v_names)) loop
    if r.only_group and not r.shared then
      update lp_snapshots set fund_id = v_new where id = r.id;
      update lp_investments set fund_id = v_new where snapshot_id = r.id;
      get diagnostics n = row_count;
      insert into split_summary values (3, 'lp_snapshots', format('moved "%s" (%s positions)', r.name, n), 1);
      continue;
    end if;
    insert into lp_snapshots
    select (jsonb_populate_record(null::lp_snapshots, to_jsonb(s) || jsonb_build_object('id', gen_random_uuid(), 'fund_id', v_new))).*
      from lp_snapshots s where s.id = r.id
    returning id into v_snap;
    if r.shared then
      insert into lp_investments
      select (jsonb_populate_record(null::lp_investments, to_jsonb(i) || jsonb_build_object('id', gen_random_uuid(), 'fund_id', v_new, 'snapshot_id', v_snap))).*
        from lp_investments i where i.snapshot_id = r.id and i.portfolio_group = any(v_names);
      get diagnostics n = row_count;
      insert into split_summary values (3, 'lp_snapshots', format('copied "%s" (%s positions; the shared original is unchanged)', r.name, n), 1);
    else
      update lp_investments set fund_id = v_new, snapshot_id = v_snap
       where snapshot_id = r.id and portfolio_group = any(v_names);
      get diagnostics n = row_count;
      insert into split_summary values (3, 'lp_snapshots', format('split "%s" (%s positions moved to the copy)', r.name, n), 1);
    end if;
  end loop;

  ------------------------------------------------------------------------------------------------
  -- 4. LP investors, LP entities and vendors: move what only the new fund uses, copy what both use.
  ------------------------------------------------------------------------------------------------
  -- Which ids of a table are referenced from rows in a given fund (through any foreign key)?
  create temp table split_refs (tbl text, id uuid, fund uuid, via text) on commit drop;
  for r in select * from split_fks where dst::text in ('lp_entities', 'lp_investors', 'vendors') and src_has_fund loop
    execute format('insert into split_refs select %L, s.%I, s.fund_id, %L from %s s where s.%I is not null and s.fund_id in ($1, $2)',
                   r.dst::text, r.col, r.src::text || '.' || r.col, r.src, r.col) using v_src, v_new;
  end loop;

  -- Investors: one moves when nothing left in the source fund points at it or at any of its
  -- entities, other than its own entities and portal links (which travel with it).
  create temp table split_inv on commit drop as
  select le.investor_id as id
    from split_refs x join lp_entities le on le.id = x.id
   where x.tbl = 'lp_entities' and x.fund = v_new and le.fund_id = v_src
  union
  select i.id
    from split_refs x join lp_investors i on i.id = x.id
   where x.tbl = 'lp_investors' and x.fund = v_new and i.fund_id = v_src;
  alter table split_inv add column moves boolean;
  update split_inv i set moves = not exists (
      select 1 from split_refs x
       where x.fund = v_src and x.tbl = 'lp_investors' and x.id = i.id
         and x.via not in ('lp_entities.investor_id', 'lp_account_links.lp_investor_id'))
    and not exists (
      select 1 from split_refs x join lp_entities le on le.id = x.id
       where x.fund = v_src and x.tbl = 'lp_entities' and le.investor_id = i.id);

  -- Moving investors take all their entities and portal links.
  update lp_investors set fund_id = v_new, parent_id = null
   where id in (select id from split_inv where moves) and parent_id is not null
     and parent_id not in (select id from split_inv where moves);
  update lp_investors set fund_id = v_new where id in (select id from split_inv where moves);
  get diagnostics n = row_count;
  insert into split_summary values (4, 'lp_investors', 'moved', n);
  update lp_entities set fund_id = v_new where investor_id in (select id from split_inv where moves);
  get diagnostics n = row_count;
  insert into split_summary values (4, 'lp_entities', 'moved (with their investor)', n);
  update lp_account_links set fund_id = v_new where lp_investor_id in (select id from split_inv where moves);

  -- Investors both funds use are copied; the copy keeps the name (names are unique per fund).
  insert into split_map
  select 'lp_investors', id, gen_random_uuid() from split_inv where not moves;
  insert into lp_investors
  select (jsonb_populate_record(null::lp_investors, to_jsonb(i) || jsonb_build_object('id', m.new_id, 'fund_id', v_new, 'parent_id', null))).*
    from lp_investors i join split_map m on m.kind = 'lp_investors' and m.old_id = i.id;
  get diagnostics n = row_count;
  insert into split_summary values (4, 'lp_investors', 'copied (used by both funds)', n);
  -- Their portal logins are linked to the copy as well.
  insert into lp_account_links (lp_account_id, fund_id, lp_investor_id, created_by)
  select l.lp_account_id, v_new, m.new_id, l.created_by
    from lp_account_links l join split_map m on m.kind = 'lp_investors' and m.old_id = l.lp_investor_id
  on conflict do nothing;
  get diagnostics n = row_count;
  insert into split_summary values (4, 'lp_account_links', 'added for copied investors', n);

  -- Their entities: an entity the source fund no longer uses moves under the copy; one both use is
  -- copied, and the new fund's rows are pointed at the copy.
  update lp_entities le set fund_id = v_new, investor_id = m.new_id
    from split_map m
   where m.kind = 'lp_investors' and le.investor_id = m.old_id
     and le.id in (select id from split_refs where tbl = 'lp_entities' and fund = v_new)
     and le.id not in (select id from split_refs where tbl = 'lp_entities' and fund = v_src);
  get diagnostics n = row_count;
  insert into split_summary values (4, 'lp_entities', 'moved (under a copied investor)', n);
  insert into split_map
  select 'lp_entities', le.id, gen_random_uuid()
    from lp_entities le
   where le.fund_id = v_src
     and le.id in (select id from split_refs where tbl = 'lp_entities' and fund = v_new);
  insert into lp_entities
  select (jsonb_populate_record(null::lp_entities, to_jsonb(le) || jsonb_build_object(
            'id', m.new_id, 'fund_id', v_new,
            'investor_id', coalesce((select mi.new_id from split_map mi where mi.kind = 'lp_investors' and mi.old_id = le.investor_id), le.investor_id)))).*
    from lp_entities le join split_map m on m.kind = 'lp_entities' and m.old_id = le.id;
  get diagnostics n = row_count;
  insert into split_summary values (4, 'lp_entities', 'copied (used by both funds)', n);

  -- Vendors.
  update vendors set fund_id = v_new
   where fund_id = v_src
     and id in (select id from split_refs where tbl = 'vendors' and fund = v_new)
     and id not in (select id from split_refs where tbl = 'vendors' and fund = v_src);
  get diagnostics n = row_count;
  insert into split_summary values (4, 'vendors', 'moved', n);
  insert into split_map
  select 'vendors', id, gen_random_uuid() from vendors
   where fund_id = v_src and id in (select id from split_refs where tbl = 'vendors' and fund = v_new);
  insert into vendors
  select (jsonb_populate_record(null::vendors, to_jsonb(x) || jsonb_build_object('id', m.new_id, 'fund_id', v_new))).*
    from vendors x join split_map m on m.kind = 'vendors' and m.old_id = x.id;
  get diagnostics n = row_count;
  insert into split_summary values (4, 'vendors', 'copied (used by both funds)', n);

  -- Point the new fund's rows at the copies.
  for r in select * from split_fks where dst::text in ('lp_entities', 'lp_investors', 'vendors') and src_has_fund loop
    execute format('update %s s set %I = m.new_id from split_map m where m.kind = %L and m.old_id = s.%I and s.fund_id = $1',
                   r.src, r.col, r.dst::text, r.col) using v_new;
    get diagnostics n = row_count;
    if n > 0 then insert into split_summary values (4, r.src::text || '.' || r.col, 'pointed at copies', n); end if;
  end loop;

  ------------------------------------------------------------------------------------------------
  -- 5. Safety checks. Any failure rolls the whole thing back.
  ------------------------------------------------------------------------------------------------
  for r in select * from split_fks where src_has_fund and dst_has_fund loop
    execute format('select count(*) from %s s join %s d on d.%I = s.%I where s.fund_id in ($1, $2) and d.fund_id is distinct from s.fund_id',
                   r.src, r.dst, r.dcol, r.col) into n using v_src, v_new;
    if n > 0 then
      v_bad := coalesce(v_bad || '; ', '') || format('%s.%s -> %s: %s', r.src, r.col, r.dst, n);
    end if;
  end loop;
  if v_bad is not null then
    raise exception 'Rows would point across the two funds: %', v_bad;
  end if;

  for r in select src, string_agg(format('%I = any($2)', col), ' or ') pred
             from split_fks where dst = 'fund_vehicles'::regclass and src_has_fund group by src loop
    execute format('select count(*) from %s where fund_id = $1 and (%s)', r.src, r.pred) into n using v_src, v_vids;
    if n > 0 then
      raise exception '% row(s) in % still in the source fund point at a moved entity', n, r.src;
    end if;
  end loop;

  select count(*) into n from lp_investments i
   where i.fund_id = v_src and i.portfolio_group = any(v_names) and not public.lp_report_is_shared(i.snapshot_id);
  if n > 0 then
    raise exception '% LP report position(s) for moved entities are still in the source fund', n;
  end if;

  raise notice 'checks passed';
end
$split$;

select step, tbl, action, n from split_summary order by step, tbl, action;

\if :apply
  commit;
  \echo 'APPLIED.'
\else
  rollback;
  \echo 'DRY RUN: rolled back. Re-run with -v apply=1 to commit.'
\endif
