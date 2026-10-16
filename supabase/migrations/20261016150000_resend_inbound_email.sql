-- Resend as an inbound email provider (replacing Mailgun, which no fund uses).
--
-- Adds the two per-fund settings the Resend inbound webhook needs and lets inbound_email_provider
-- say 'resend'. The fund's Resend API key reuses resend_api_key_encrypted (the outbound key): a
-- fund's inbound and outbound mail live in the same Resend account, and the key must have full
-- access so the webhook can read the received email and its attachments.
--
-- 'mailgun' stays allowed here so this file is safe to apply before the release that removes the
-- Mailgun code. supabase/pending-deploy/drop_mailgun.sql narrows the checks and drops the Mailgun
-- columns once that release is live.

alter table fund_settings
  add column if not exists resend_inbound_domain text,
  add column if not exists resend_webhook_secret_encrypted text;

alter table fund_settings drop constraint if exists fund_settings_inbound_email_provider_check;
alter table fund_settings
  add constraint fund_settings_inbound_email_provider_check
  check (inbound_email_provider in ('postmark', 'mailgun', 'resend'));
