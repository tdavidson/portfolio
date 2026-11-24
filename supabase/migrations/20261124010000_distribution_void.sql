-- A declared distribution can be VOIDED (lib/accounting/distribution-void.ts): its declaration
-- entries come off the books (voided, or reversed in an open period when the declaration sits in
-- a closed one) and the register row is kept, marked void, with who did it, when and why. A void
-- row no longer lists, notices or counts toward K-1 box 19 (which reads status = 'declared').

alter table public.distributions drop constraint if exists distributions_status_check;
alter table public.distributions
  add constraint distributions_status_check check (status in ('draft', 'declared', 'void'));

alter table public.distributions
  add column if not exists voided_at   timestamptz,
  add column if not exists voided_by   uuid,
  add column if not exists void_reason text;
