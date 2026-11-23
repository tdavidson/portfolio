-- Partners' bank details for distributions, as data rather than only an uploaded file, so a
-- payout sheet can list them and a change can be caught field by field.
--
-- One row per LP entity. The account and routing numbers are encrypted by the application
-- (AES-256-GCM, a key derived from ENCRYPTION_KEY, which never reaches the database), stored in
-- the *_encrypted columns, with the last four digits beside them for display. Everything else is
-- plain text: names, addresses and SWIFT/BIC codes identify a bank, not an account.
--
-- Only the service role may reach the table. Its routes are admin-only for anything that writes
-- or shows a full number (lib/access/admin-only.ts), and the Data API grants nothing to anon or
-- authenticated, so a member refused by the routes cannot read it from the browser either. With
-- RLS on and no policies, a grant that creeps back still denies every row.
--
-- Verification is a callback: who was called, on which number, when. Any change to the details
-- clears it, and the person who entered or changed the details cannot verify them (dual control,
-- enforced in lib/lps/wire-instructions.ts).
--
-- Idempotent: safe to paste twice.

create table if not exists public.lp_wire_instructions (
  id                        uuid primary key default gen_random_uuid(),
  fund_id                   uuid not null references public.funds(id) on delete cascade,
  lp_entity_id              uuid not null references public.lp_entities(id) on delete cascade,
  beneficiary_name          text not null,
  beneficiary_address       text,
  bank_name                 text not null,
  bank_address              text,
  routing_number_encrypted  text,
  routing_last4             text,
  swift_code                text,
  account_number_encrypted  text not null,
  account_last4             text not null,
  intermediary_bank         text,
  intermediary_swift        text,
  reference                 text,
  currency                  text,
  status                    text not null default 'unverified' check (status in ('unverified', 'verified')),
  entered_by                uuid references auth.users(id) on delete set null,
  entered_at                timestamptz not null default now(),
  verified_by               uuid references auth.users(id) on delete set null,
  verified_at               timestamptz,
  verification_note         text,
  verified_digest           text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (fund_id, lp_entity_id)
);

-- For a copy of this file pasted before verified_digest was added.
alter table public.lp_wire_instructions add column if not exists verified_digest text;

create index if not exists lp_wire_instructions_fund_idx on public.lp_wire_instructions (fund_id);

comment on table public.lp_wire_instructions is 'Partners'' bank details for distributions. Account and routing numbers are encrypted by the app; service role only.';
comment on column public.lp_wire_instructions.entered_by is 'Who entered or last changed the details. They cannot also verify them.';
comment on column public.lp_wire_instructions.verified_digest is 'HMAC sealing the verification to the exact details checked (app key). A mismatch reads as unverified.';
comment on column public.lp_wire_instructions.verification_note is 'The callback: who was called, the number, the date, and what was confirmed.';

-- Service role only, reads included (see the header).
revoke all on public.lp_wire_instructions from anon, authenticated;
grant select, insert, update, delete on public.lp_wire_instructions to service_role;

alter table public.lp_wire_instructions enable row level security;
