-- PENDING DEPLOY — do not move into supabase/migrations/ until this release is live:
--
--   The release that removes Mailgun (app/api/inbound-email/mailgun deleted, lib/email.ts no longer
--   sends via Mailgun, and Settings, onboarding and lib/onboarding/connection-settings.ts no longer
--   read or write mailgun_* columns or offer 'mailgun' as a provider).
--
-- Why it must wait: the release before that one selects mailgun_inbound_domain,
-- mailgun_signing_key_encrypted, mailgun_api_key_encrypted and mailgun_sending_domain from
-- fund_settings (the Settings page, lib/email.ts, onboarding). Dropping the columns under it makes
-- those selects fail, and lib/email.ts would stop sending for every fund, not only Mailgun ones.
--
-- When moving it: rename to a current timestamp, e.g. supabase/migrations/<now>_drop_mailgun.sql.
--
-- What it does: clears any leftover 'mailgun' provider choice (no fund uses Mailgun), narrows the
-- provider checks to the providers the app supports, and drops the Mailgun columns.

update fund_settings set inbound_email_provider = null where inbound_email_provider = 'mailgun';
update fund_settings set outbound_email_provider = null where outbound_email_provider = 'mailgun';
update fund_settings set asks_email_provider = null where asks_email_provider = 'mailgun';

alter table fund_settings drop constraint if exists fund_settings_inbound_email_provider_check;
alter table fund_settings
  add constraint fund_settings_inbound_email_provider_check
  check (inbound_email_provider in ('postmark', 'resend'));

alter table fund_settings drop constraint if exists fund_settings_outbound_email_provider_check;
alter table fund_settings
  add constraint fund_settings_outbound_email_provider_check
  check (outbound_email_provider in ('resend', 'postmark', 'gmail'));

alter table fund_settings
  drop column if exists mailgun_inbound_domain,
  drop column if exists mailgun_signing_key_encrypted,
  drop column if exists mailgun_api_key_encrypted,
  drop column if exists mailgun_sending_domain;
