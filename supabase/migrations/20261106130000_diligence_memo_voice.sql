-- A fund's memo voice: the voice, house rules and examples every investment memo is written in, by
-- the memo agent's draft stage and by an assistant connected over MCP (diligence_memo_skill). Learned
-- from the fund's sample memos and edited by the partners. One row per fund; no row means the general
-- voice in the investment-memo skill.
--
-- Read and written only through gated routes and agent tools with the service-role client, so the
-- Data API grant is service_role alone and there are no authenticated policies (RLS denies by default).

create table public.diligence_memo_voice (
  fund_id       uuid primary key references public.funds(id) on delete cascade,
  voice         text,
  house_rules   text,
  examples      text,
  learned_from  jsonb not null default '[]'::jsonb,   -- style_anchor_memos ids the voice was learned from
  learned_at    timestamptz,
  updated_by    uuid references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now()
);

revoke all on public.diligence_memo_voice from anon, authenticated;
grant select, insert, update, delete on public.diligence_memo_voice to service_role;

alter table public.diligence_memo_voice enable row level security;
