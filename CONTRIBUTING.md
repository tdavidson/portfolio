# Contributing

Thanks for your interest in improving this project. It's an open-source portfolio
reporting platform for fund managers, and contributions are welcome.

## Ways to contribute

- **Report a bug or request a feature.** Open a [GitHub issue](https://github.com/tdavidson/portfolio/issues).
  Include your deployment setup (self-hosted, managed, hosted), steps to reproduce, and any relevant logs.
- **Submit a fix or improvement.** Fork the repo, create a branch, and open a pull request.
- **Improve the docs,** Corrections and clarifications to the README, `DOCS.md`, or `FEATURES.md` are just as valuable as code.

## Licensing of contributions

This project is licensed under the [Apache License 2.0](./LICENSE.md). Per Section 5 of
the license, any contribution you intentionally submit for inclusion in the project is
provided under the same Apache 2.0 terms, with no additional terms or conditions. No
separate contributor license agreement (CLA) is required.

Note that the license does not grant rights to the "Hemrock" or "Unstructured Ventures"
names or logos (see [`NOTICE`](./NOTICE)). If you fork or redeploy the project, please use
your own branding.

## Page performance and access

Server layouts and pages share `getUser()` and `resolvePageAccess()` through React's
request cache. Membership, role, domain grants and entity scope come from the live
`access_context` RPC. Keep these decisions fresh between requests; cached branding
and optional navigation indicators are separate from authorization. API proxy and
handler checks remain independent security boundaries.

The dashboard loads card values with per-metric embedded limits, not one history
request per card. Company charts use `/api/companies/[id]/metrics/values`, with the
same RLS and portfolio/entity gate as the individual history endpoint. Sidebar
badges and the release indicator stream independently after the shell can render.
The table embeds metric history and latest cash in one query per company page.
The dashboard and entity picker share a request-local transaction loader; investment
history is paginated so database row caps cannot truncate financial calculations.
Open reviews use an aggregate count. Updates, documents, and interactions mount as
they approach the viewport, with button and anchor activation as alternatives.
No database migration is required for these paths.

Fund subpages provide their URL-resolved vehicle through `VehiclePageScope` before
children render. Keep this scope independent of sidebar/local-storage hydration;
otherwise mounted report effects can issue a request for the old vehicle and then
repeat it. The switcher consumes the provider's vehicle index instead of fetching
another copy. Server API authorization remains authoritative.

Fund economics accepts a gated `group` filter. Its heavy preload covers only the
selected/visible vehicles; single-vehicle timeseries uses the same scoped preload.
Names, ownership metadata, and investment price signals retain their existing
semantics. The ledger landing loads only the chart until an account is selected.
Fund detail, tax, bank, and capital accounts update independent sections as their
requests finish, with generation checks preventing superseded results from being
displayed after a vehicle/date change. Do not make the primary table wait for
secondary history, distributions, reconciliation, or chart sections.

Forecast's `initial=1` list response includes the default plan so the first view
does not need another gated detail request. Statement consumers needing only the
schedule use `section=soi`; full statements and exports keep their existing shape.
Accounting helpers reuse access on a server-created gate object only for that
request. Never retain those gate objects across requests.

Usage and diligence analytics require
`20261016004405_compact_reporting_views.sql` **before deploying the application
changes**. The additive, security-invoker views are readable only by `service_role`;
the existing admin gates remain in the routes. They summarize usage by UTC day
and replace memo JSON with presence flags, respectively. Missing views produce an
error, not false zero totals. The repository owner applies remote migrations.
`scripts/check-reporting-views.mjs` validates the migration in an isolated PGlite
database with synthetic fixtures; pass the path to an installed
`@electric-sql/pglite/dist/index.js` to run it without adding an app dependency.

For performance comparisons, use a production build and measure cold and warm
loads for an admin and an entity-scoped member. Record document/RSC response times,
API request counts, transferred bytes, and time until metrics appear. Confirm that
revoking a domain or entity grant takes effect on the next server request. Query
builder tests verify request shape; production timings and query plans still need
to be measured against a representative deployment.

Run `npm run perf:check` for a synthetic Chrome regression check of deferred panels
(initial requests/bytes, scroll, manual activation, anchors, and browser fallback).
It needs an installed Chrome/Chromium; set `CHROME_PATH` if necessary. Synthetic
timings are not representative of production data or access policies.

For signed-in measurements, run `npm run build` and `npm start`, then:

```sh
npm run perf:pages -- --url http://localhost:3000/dashboard --label admin --interactive
npm run perf:pages -- --url http://localhost:3000/dashboard --label scoped-member --interactive
```

Repeat for a company URL and on the baseline revision with the same accounts and
data. The script opens a fresh browser for normal sign-in, then records five visits
with browser caching disabled and five with it enabled. Server/database caches are
untouched. Reports include median/p95 TTFB, FCP, LCP, metrics-ready time, request
counts, and bytes, plus per-run API error counts and whether the network settled.
Use `--selector '[data-page-ready]'` to measure initial page readiness separately;
for older revisions, supply a CSS selector for an equivalent visible element.
`--samples` and `--output` customize
sampling and numeric JSON output. A private `--cookies-file` can replace interactive
sign-in; never commit it or share credentials. Reports exclude page contents,
response bodies, URLs, and cookies. Review API errors before comparing timings.

## Questions

For anything else, including setup help, larger changes you'd like to discuss first, or commercial
support, reach out to Taylor Davidson at hello@hemrock.com.
