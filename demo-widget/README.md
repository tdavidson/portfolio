# The public demo widget

The product, mounted on www.hemrock.com/demo around a sample fund: the app's own shell
(header, sidebar, command palette, Analyst, phone tab bar) and every page a viewer can open,
rendered by the same components the app renders, on a snapshot of the demo fund. No sign-in,
no database, no model call: the data is recorded, and the Analyst's replies are stored.

## How it works

Two substitutions make the app's component tree run inside a static page:

- **`fetch`.** While the widget is mounted every `/api/*` request on the page is answered by
  `mock-api.ts`: first from `data/api.json` (what the real API returned to the demo fund's
  viewer for that request), then from `data/snapshot.json` for the routes the palette and the
  Analyst call, then 404, which every component already treats as "empty". Writes get the
  read-only demo's 403. The components that take `fetch` from `components/app-runtime.tsx`
  get it there; the rest call the global, which `index.tsx` wraps before the first render.
- **`navigate`.** `app.tsx` keeps the current path in state and swaps the page instead of the
  URL. `stubs/next-navigation.ts` answers `usePathname`, `useParams` and `useSearchParams` from
  it through React context, so a page never sees the URL of the page replacing it (as in Next),
  and `stubs/next-link.tsx` renders the app's links as anchors the frame intercepts.
- **Hrefs.** The host mounts the widget under a path of its own (`basePath: '/demo'`, or
  `hrefFor` for anything a prefix cannot express), and `hrefs.ts` writes every link with it
  (`/demo/companies/<id>`), so a new tab, a middle-click, a copied link or a crawler lands on
  the demo rather than the host's bare `/companies/<id>`. The app's path rides along as
  `data-app-href` for the click handler; `onNavigate` and `navigate` still speak app paths.
  Plain `<a href>` anchors the app renders outside `next/link` are rewritten the same way as
  they appear. Links to pages the demo deliberately leaves out are hidden (`HIDDEN_IN_DEMO`),
  and the import templates are inlined as `data:` downloads.
- **No session.** The header's sign-out is "Exit demo", a link back to the host (`exitHref`),
  through the runtime's `exit`. Every refused change raises one "Read-only demo" notice.

`routes.tsx` is the table: each of the app's URL patterns and the component the app renders
for it. A client page (`'use client'` under `app/(app)`) is mounted as is. A server page —
one that queried Postgres in the component — has been split into a loader (`load.ts`, run by
the page and by the snapshot script) and a client view (`page-view.tsx`, mounted by the page
and by the widget); the widget hands the view the loader's recorded output from
`data/pages.json`, keyed by URL, or a thinner equivalent `fallbacks.ts` builds from the
snapshot until that has been recorded. `lib/pages/registry.ts` lists the loaders and how to
enumerate their URLs for a fund. `routes.test.ts` fails when a page exists in the app
without a demo route or a reason, and `pages-render.test.tsx` fails when a page links to a
URL the widget does not build (and does not hide).

`build.mjs` bundles `index.tsx` with esbuild (React included; `next/*`, `next-themes`, `xlsx`
and the browser Supabase client swapped for `stubs/`) as an ES module split by section. The
stylesheet is the app's own: `app/globals.css` compiled with the app's Tailwind config for
exactly the files in the bundle, then scoped by `scope-css.mjs`, which rewrites only the
selectors so each rule matches inside the widget and nowhere else, at the same specificity
it has in the app. The widget's frame and every portal it opens carry `oa-demo-root`; a short
reset in front puts their elements back to browser defaults, so the host page's stylesheet
never reaches them and the app's rules apply exactly as they do in the app. Rem sizes are
compiled to the pixels the app renders at, so a host's root font size cannot scale the demo.

The build writes:

| File | What |
| --- | --- |
| `dist/widget.js` | IIFE exposing `PortfolioDemo.mount(el, { snapshot, answers, pages, api, chrome: 'page' \| 'card', initialPath, onNavigate, basePath, hrefFor })` and `PortfolioDemo.routes(snapshot, pages)` |
| `dist/widget.css` | the app's stylesheet, scoped; `dark` on `<html>` switches the theme |
| `dist/snapshot.json` | the sample fund (`types.ts` is the contract; `schemaVersion` guards it) |
| `dist/pages.json` | every server page's loaded data, keyed by URL |
| `dist/api.json` | every recorded API response, keyed by method, path and query |
| `dist/answers.json` | stored Analyst replies, suggestions per scope, and the fallback text |
| `dist/manifest.json` | version, build time, schema versions, `generatedBy` of the answers, and the SHA-256 of every file |

```bash
npm run demo:widget          # builds dist/; dist/ is gitignored
npm run demo:check           # walks every page of the build in Chromium; crashes fail, misses are listed
npm run demo:check -- --shots /tmp/shots   # and screenshots each page
npm run demo:styles          # the demo against the app in a browser, style by style
```

`scope-css.test.ts` runs with the app's unit tests on every push: it compiles the app's
stylesheet, scopes it, and fails unless every rule is the app's with only the zero-weight
scope added to its selector. That is what keeps the demo's styles the app's, and it takes
seconds. `demo:styles` is the in-browser proof of the same thing, for when `scope-css.mjs`
itself changes: it renders pages under the app's stylesheet and under the widget's inside
`check-host.css`, a host page written to restyle everything, and diffs every element's
computed style. It renders each page twice, so it is not in the publish workflow.

## Publishing

`.github/workflows/demo-widget.yml` rebuilds on every push to `main` that touches
`app/`, `components/`, `lib/`, `demo-widget/`, the tokens or the Tailwind config, runs the
check, and uploads `dist/*` as the assets of the rolling GitHub release `demo-widget-latest`.
The marketing site's build downloads them from there and checks the manifest, so a change to
any page reaches the demo on the site's next deploy.

The release's files are replaced one at a time, so a site build that downloads during a publish
can get some files from each build. Two things stop that from shipping: the site checks every
file against the manifest's SHA-256s and retries until they agree, and the workflow deletes only
assets older than the previous build (chunk names are content hashes, so without that they pile
up to GitHub's 1,000-asset limit), so a download of the previous build can still finish. The workflow does not trigger that
deploy: a deploy hook here rebuilt production on every push to this repo, so the demo waits
for the site's own next deploy (or a manual redeploy in Vercel).

## Keeping the data current

The demo fund's own data comes from the seeds in `scripts/demo-seed/` (each with a `-remove.sql`),
applied once by hand in the SQL editor; `demo-seed-oct-2026.sql` adds what the LP letter, capital call
and close features show. Then three files, three scripts, all run locally against the demo fund and
committed:

1. `npm run demo:snapshot` (`DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` for a viewer in the demo
   fund, `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`; `DEMO_FUND_NAME` picks
   the fund, `DEMO_FUND_LABEL` the name shown) re-exports `data/snapshot.json` and runs every
   loader in `lib/pages/registry.ts` as that viewer into `data/pages.json`. Without the service
   role key it runs entirely as the viewer, so RLS bounds everything it can export.
2. `npm run demo:widget && DEMO_ORIGIN=https://<the app> DEMO_EMAIL=… DEMO_PASSWORD=… npm run demo:record`
   signs in to a running instance as the viewer, mounts the build with `/api` proxied to it,
   walks every page and every tab, and records the responses into `data/api.json`. The
   middleware and RLS are in the path, so it can only record what the viewer sees, and only
   GET requests reach the instance: anything else the pages send is refused, so recording
   never writes or starts a paid Analyst call. With `DEMO_SUPABASE_URL` and
   `DEMO_SUPABASE_KEY` (the publishable key) it signs in through Supabase directly rather
   than the app's bot-checked `/auth`; set `DEMO_FUND_NAME` so the fund's real name is
   relabelled. Behind an HTTPS proxy, run it with `NODE_USE_ENV_PROXY=1`.
3. `ANTHROPIC_API_KEY=… DEMO_SUPABASE_URL=… DEMO_SUPABASE_KEY=… DEMO_PASSWORD=… npm run demo:answers`
   asks the real Analyst every question in `data/answers.json`, signed in as the demo viewer
   (`DEMO_EMAIL`, default hello@hemrock.com) so RLS and the grants apply, and stores the replies
   with the model that wrote them (`DEMO_MODEL`, default claude-sonnet-5). It spends the key in
   the environment, not the fund's, so run it when the snapshot or the question list changes,
   not routinely. Behind an HTTPS proxy, run it with `NODE_USE_ENV_PROXY=1`.
   Until it has been run, `generatedBy` is `authored`: the replies were written by hand
   against the snapshot and read as the Analyst would, but no model produced them.

`npm run demo:check` after a build says which requests the recording does not cover; a page
whose data is missing renders its empty state, not an error. To add a question, add an
entry to `answers` (scope `portfolio` or `company:<id>`, a question, optional `aliases`) and,
if it should be offered, to `suggestions`.

## When the app changes

- A **new client page**: add a route to `routes.tsx`; `routes.test.ts` says so until you do.
- A **new server page**: give it a `load.ts` and a `page-view.tsx` like `app/(app)/deals`,
  register the loader, add the route, and re-run the snapshot.
- A **component that reads a new API route**: the check lists it as unanswered; re-run the
  recorder.
- A **field the snapshot lacks**: add it to `types.ts` and `scripts/demo-snapshot.ts`, bump
  `DEMO_SCHEMA_VERSION` if the shape changes incompatibly, and the site's build refuses a
  widget and snapshot that disagree.
