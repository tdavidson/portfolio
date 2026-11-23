-- A reviewer's sign-off on a declared distribution's calculation: who checked it against the
-- waterfall and the LPA, when, and what they noted. One sign-off per distribution, replaced by the
-- next; the audit trail keeps the history. Nothing is gated on it: notices can go out without it,
-- and the Capital accounts page and the workbook say plainly when a distribution has none.
--
-- Idempotent: safe to paste twice.

alter table public.distributions add column if not exists reviewed_by uuid references auth.users(id) on delete set null;
alter table public.distributions add column if not exists reviewed_at timestamptz;
alter table public.distributions add column if not exists review_note text;

comment on column public.distributions.reviewed_by is 'Who signed off the distribution''s calculation.';
comment on column public.distributions.reviewed_at is 'When the calculation was signed off. Null = not reviewed.';
comment on column public.distributions.review_note is 'What the reviewer noted when signing off.';
