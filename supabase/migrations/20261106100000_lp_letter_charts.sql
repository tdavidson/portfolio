-- Charts in LP letters (lib/lp-letters/charts.ts).
--
-- 1. lp_letters.charts: the charts placed in a letter, each with its caption, the section it
--    follows, and the storage path and hash of its image.
-- 2. The private lp-letter-charts bucket. Images are stored under their own hash and never
--    overwritten, so a final letter prints the images it was reviewed with. Only the service-role
--    key reads or writes it (the letter routes, after the lp_letters gate and the entity check): no
--    storage policies, so no member reaches it from the browser.
--
-- Additive.

alter table public.lp_letters add column if not exists charts jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lp-letter-charts', 'lp-letter-charts', false, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;
