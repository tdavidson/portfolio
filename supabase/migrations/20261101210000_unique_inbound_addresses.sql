-- One fund per inbound address. fund_settings.resend_inbound_domain and postmark_inbound_address
-- had no unique index, so a second fund could claim another fund's domain and, where both used the
-- deployment's shared webhook credentials, receive its mail. The settings route now refuses a
-- taken value with a 409, and lib/resend/inbound.ts delivers to neither fund when two match; these
-- indexes make it impossible.
--
-- If two funds already share a value, the index for that column is skipped with a NOTICE naming
-- how many: clear the wrong fund's value in Settings and run this file again.
--
-- Also clears the legacy plaintext postmark_webhook_token wherever an encrypted copy exists (the
-- webhook route already prefers the encrypted one, and retires the plaintext on use).
--
-- Idempotent: safe to run twice.

do $$
declare
  dupes int;
begin
  select count(*) into dupes from (
    select lower(btrim(resend_inbound_domain)) from public.fund_settings
     where nullif(btrim(resend_inbound_domain), '') is not null
     group by 1 having count(*) > 1
  ) d;
  if dupes > 0 then
    raise notice 'resend_inbound_domain: % value(s) shared by more than one fund; unique index not created', dupes;
  else
    create unique index if not exists fund_settings_resend_inbound_domain_key
      on public.fund_settings (lower(btrim(resend_inbound_domain)))
      where nullif(btrim(resend_inbound_domain), '') is not null;
  end if;

  select count(*) into dupes from (
    select lower(btrim(postmark_inbound_address)) from public.fund_settings
     where nullif(btrim(postmark_inbound_address), '') is not null
     group by 1 having count(*) > 1
  ) d;
  if dupes > 0 then
    raise notice 'postmark_inbound_address: % value(s) shared by more than one fund; unique index not created', dupes;
  else
    create unique index if not exists fund_settings_postmark_inbound_address_key
      on public.fund_settings (lower(btrim(postmark_inbound_address)))
      where nullif(btrim(postmark_inbound_address), '') is not null;
  end if;
end $$;

update public.fund_settings
   set postmark_webhook_token = null
 where postmark_webhook_token is not null
   and postmark_webhook_token_encrypted is not null;
