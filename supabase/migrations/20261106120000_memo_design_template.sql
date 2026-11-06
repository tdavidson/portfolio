-- Memo design template: the sample memo (a style anchor, as a Word file) that every memo export is
-- written into, so exported memos carry the fund's own design: fonts, heading and body styles,
-- margins, header, footer, logo, first page and section headings. Null keeps the standard layout.
--
-- Additive. The file itself stays in the fund's style-anchor-memos storage.

alter table public.fund_settings
  add column if not exists memo_design_anchor_id uuid references public.style_anchor_memos(id) on delete set null;

comment on column public.fund_settings.memo_design_anchor_id is
  'The sample memo (style_anchor_memos row, a .docx) whose design memo exports copy. Null: standard layout.';

-- fund_settings is readable by members column by column; a new column needs the grant refreshed.
select public.grant_fund_settings_member_columns();
