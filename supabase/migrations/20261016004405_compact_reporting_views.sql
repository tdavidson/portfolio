-- Additive: deploy this before application code reads these views.
-- Read through the caller's privileges. Only server-side, admin-gated reporting routes use them.
create or replace view public.reporting_usage_daily
with (security_invoker = true) as
select fund_id,
       (date_trunc('day', created_at at time zone 'UTC') at time zone 'UTC') as created_at,
       provider, model,
       sum(input_tokens) as input_tokens,
       sum(output_tokens) as output_tokens,
       sum(audio_seconds) as audio_seconds,
       sum(web_searches) as web_searches
from public.ai_usage_logs
group by fund_id, (date_trunc('day', created_at at time zone 'UTC') at time zone 'UTC'), provider, model;

create or replace view public.reporting_diligence_drafts
with (security_invoker = true) as
select id, fund_id, deal_id, is_draft, finalized_at, created_at,
       coalesce(ingestion_output not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false) as has_ingestion,
       coalesce(research_output not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false) as has_research,
       coalesce(memo_draft_output not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false) as has_memo_draft,
       case when jsonb_typeof(qa_answers) = 'array' then jsonb_array_length(qa_answers) > 0 else false end as has_qa
from public.diligence_memo_drafts;

revoke all on public.reporting_usage_daily, public.reporting_diligence_drafts from public, anon, authenticated;
grant select on public.reporting_usage_daily, public.reporting_diligence_drafts to service_role;
