-- Lets the signed-in user ask whether their own account has a password, so Settings can
-- label the card "Set password" (signed up with one-time codes only) or "Change password".
-- auth.users is not readable from the Data API, so this reads it as definer and returns
-- only a boolean about auth.uid() itself: nothing about any other user.

create or replace function public.current_user_has_password()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select u.encrypted_password is not null and u.encrypted_password <> ''
       from auth.users u
      where u.id = auth.uid()),
    false
  );
$$;

revoke execute on function public.current_user_has_password() from public, anon;
grant execute on function public.current_user_has_password() to authenticated;
