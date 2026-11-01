-- The RLS helpers ignored fund_members.access_expires_at. access_context (the API gate) already
-- treats a member whose access has expired as no member, but the hourly sweep is what deletes the
-- row, and until it runs these helpers still answered for them: through the Data API, with the
-- anon key and their session, an expired member could still read (and, where granted, write) their
-- old fund's rows, and the connector pool still offered that fund.
--
-- Each is recreated with the same signature, language, volatility, SECURITY DEFINER and
-- search_path, and one added condition on the membership row:
--
--   (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now())
--
-- Admins never expire (the app refuses an expiry on an admin). fund_ids_readable/writable go
-- through domain_access, so they follow it. CREATE OR REPLACE keeps each function's grants.
--
-- Idempotent: safe to run twice.

create or replace function public.get_my_fund_ids()
returns uuid[] language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(m.fund_id), '{}') from fund_members m
   where m.user_id = auth.uid()
     and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now());
$$;

create or replace function public.member_fund_ids()
returns uuid[] language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(m.fund_id), '{}'::uuid[]) from fund_members m
   where m.user_id = auth.uid()
     and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now());
$$;

create or replace function public.is_fund_member()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from fund_members m
                  where m.user_id = auth.uid()
                    and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now()));
$$;

create or replace function public.is_fund_admin(check_fund_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from fund_members m
    where m.fund_id = check_fund_id
      and m.user_id = auth.uid()
      and m.role = 'admin'
  );
$$;

create or replace function public.is_fund_writer(check_fund_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from fund_members m
    where m.fund_id = check_fund_id
      and m.user_id = auth.uid()
      and m.role in ('admin', 'member')
      and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now())
  );
$$;

create or replace function public.unscoped_fund_ids()
returns uuid[] language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(m.fund_id), '{}'::uuid[]) from fund_members m
   where m.user_id = auth.uid() and (m.role in ('admin', 'viewer') or m.all_entities)
     and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now());
$$;

create or replace function public.vehicle_ids_readable()
returns uuid[] language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(v.id), '{}'::uuid[])
    from fund_members m
    join fund_vehicles v on v.fund_id = m.fund_id
   where m.user_id = auth.uid()
     and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now())
     and (m.role in ('admin', 'viewer') or m.all_entities
          or exists (select 1 from fund_member_vehicles g
                      where g.fund_id = m.fund_id and g.user_id = m.user_id and g.vehicle_id = v.id));
$$;

-- 20261101190000's write twin, only if that migration has run.
do $do$
begin
  if to_regprocedure('public.vehicle_ids_writable()') is not null then
    execute $f$
      create or replace function public.vehicle_ids_writable()
      returns uuid[] language sql stable security definer set search_path = public
      as $$
        select coalesce(array_agg(v.id), '{}'::uuid[])
          from fund_members m
          join fund_vehicles v on v.fund_id = m.fund_id
         where m.user_id = auth.uid()
           and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now())
           and (m.role in ('admin', 'viewer') or m.all_entities
                or exists (select 1 from fund_member_vehicles g
                            where g.fund_id = m.fund_id and g.user_id = m.user_id and g.vehicle_id = v.id
                              and coalesce(g.level, 'write') = 'write'));
      $$
    $f$;
  end if;
end
$do$;

create or replace function public.count_unread_notes(p_user_id uuid)
returns bigint language sql stable security definer set search_path = public, pg_temp
as $$
  with m as (select fund_id, (role in ('admin', 'viewer') or all_entities) as unscoped from fund_members
              where user_id = p_user_id
                and (role = 'admin' or access_expires_at is null or access_expires_at > now())),
       g as (select vehicle_id from fund_member_vehicles where user_id = p_user_id),
       c as (select distinct cv.company_id from company_vehicles cv where cv.vehicle_id in (select vehicle_id from g))
  select count(*)
    from company_notes cn
    join m on m.fund_id = cn.fund_id
   where cn.user_id <> p_user_id
     and (m.unscoped
          or (cn.vehicle_id in (select vehicle_id from g)
              and (cn.company_id is null or cn.company_id in (select company_id from c))))
     and not exists (select 1 from note_reads nr where nr.note_id = cn.id and nr.user_id = p_user_id);
$$;

create or replace function public.master_admin_pool(p_emails text[])
returns table(user_id uuid, email text, fund_id uuid, fund_name text, role text)
language sql stable security definer set search_path = public
as $$
  select u.id, lower(u.email)::text, m.fund_id, f.name, m.role::text
    from auth.users u
    join fund_members m on m.user_id = u.id
    join funds f on f.id = m.fund_id
   where lower(u.email) = any (select lower(e) from unnest(p_emails) e)
     and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now())
   order by f.name
$$;

-- domain_access: its current body with the membership read narrowed the same way.
create or replace function public.domain_access(p_fund_id uuid, p_domain text, p_feature text default null)
returns text language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_role    text;
  v_key     text;
  v_level   text;
  v_own     text;
  v_implied text;
begin
  if v_uid is null or p_fund_id is null or p_domain is null then
    return 'none';
  end if;

  select m.role into v_role
    from fund_members m
   where m.fund_id = p_fund_id and m.user_id = v_uid
     and (m.role = 'admin' or m.access_expires_at is null or m.access_expires_at > now());
  if v_role is null then
    return 'none';
  end if;
  -- fund_members.role is text; anything unrecognised is the least power (normalizeRole).
  if v_role not in ('admin', 'member', 'viewer') then
    v_role := 'member';
  end if;

  -- The fund-level switch is a ceiling nobody clears.
  v_key := coalesce(p_feature, public.domain_primary_feature(p_domain));
  if v_key is null then
    v_level := 'everyone';
  else
    select coalesce(fs.feature_visibility ->> v_key, public.feature_default(v_key))
      into v_level
      from fund_settings fs
     where fs.fund_id = p_fund_id;
    v_level := coalesce(v_level, public.feature_default(v_key));
  end if;

  -- 'hidden' is legacy for 'off'. Both deny everyone, admins included.
  if v_level in ('off', 'hidden') then
    return 'none';
  end if;

  -- DOMAIN_META.admin.adminOnly
  if p_domain = 'admin' then
    return case when v_role = 'admin' then 'write' else 'none' end;
  end if;

  if v_role = 'admin' then
    return 'write';
  end if;

  -- The read-only demo reads everything switched on. Grants never widen it past read.
  if v_role = 'viewer' then
    return 'read';
  end if;

  if v_level = 'admin' then
    v_own := 'none';
  else
    select a.level into v_own
      from fund_member_access a
     where a.fund_id = p_fund_id and a.user_id = v_uid and a.domain = p_domain;
    if v_own is null then
      select d.level into v_own
        from fund_domain_defaults d
       where d.fund_id = p_fund_id and d.domain = p_domain;
    end if;
    v_own := coalesce(v_own, 'none');
  end if;

  -- Granting the books has already granted partner capital (one capital account per partner,
  -- named for them). After the off/hidden check, and one hop only.
  if p_domain = 'lp_capital' then
    v_implied := public.domain_access(p_fund_id, 'accounting');
    if public.access_rank(v_implied) > public.access_rank(v_own) then
      return v_implied;
    end if;
  end if;

  return v_own;
end;
$$;
