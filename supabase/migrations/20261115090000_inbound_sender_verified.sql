-- Whether intake showed an inbound email really came from its From address (lib/pipeline/sender-verified.ts).
--
-- The webhook routes give a member's treatment only to mail whose sender passed SPF/DKIM/DMARC.
-- Reprocessing (the Emails page button and the reprocess_company_update tool) re-read the stored
-- payload with nothing but the From header to go on, so a spoof stored as an outsider's mail came
-- back as the member's on the second run. Intake now records its decision here and reprocessing
-- honours it. Mail stored before this column existed counts as unverified.
--
-- Service-role only, like the rest of the pipeline's bookkeeping: no member column grant.
--
-- Idempotent: safe to paste twice.

alter table public.inbound_emails
  add column if not exists sender_verified boolean not null default false;
