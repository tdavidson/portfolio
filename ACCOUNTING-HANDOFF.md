# Unified accounting: implementation handoff

Updated 2026-10-06. The unified application is **committed (`a4008ced`) and deployed**, and migrations 1–4 below are applied. One migration and its matching code change are pending; the remaining gaps are authenticated browser workflows and a comparison on authorized data.

## Objective and non-negotiable behavior

Retire the entity-wide accounting-on/off and LP-tracking-versus-accounting distinction. Accounting actions are always available; create accounts only when a write needs them. Use the label “Accounting.” Management companies show operating book health, not LP allocation requirements. Investments and entered LP balances must remain usable and unchanged when journals, bank activity, or QuickBooks records are imported. Imports must show differences and possible overlaps before confirmation. Never silently add two representations of the same economic activity. Preserve unknown versus zero, reported observation dates, and immutable published reports.

**Deployment state.** `20261006164431`, `20261006174407`, `20261006174711` and `20261006190000` are applied, and the unified application is deployed. Two entities are fully onboarded to accounting — *tern spv* and *tern spv associates* — and a few others are mid-setup. No agent has applied a migration, imported anything, deployed, or committed; the owner does all four.

## Validation status

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Clean. |
| `npx vitest run` | **242 files, 2,441 tests passed.** |
| `npm run sql:check:accounting` | **Passes.** Both SQL scripts against a real PostgreSQL 17 server. |
| `npm run lint` | 1 error, 195 warnings — all pre-existing. The error (`tests/auth-brand.test.tsx` `react/no-children-prop`) is committed and untouched by this work. |
| `git diff --check` | Clean. |
| Authenticated browser workflows | **Never run.** Still the largest remaining gap. |
| Production-shaped comparison | **Never run.** Needs authorized data. |

## Running the SQL checks

```
npm run sql:check:accounting
```

`scripts/run-unified-accounting-sql-checks.mjs` starts a throwaway PostgreSQL cluster in a short-pathed temp directory, installs a `pg` client there (not a project dependency), creates two databases, runs both check scripts, and tears the cluster down. It needs PostgreSQL binaries on `PATH` (`brew install postgresql@17`) and nothing else — no Docker, no Supabase project, no network.

- `scripts/unified-accounting-sql-fixture.mjs` — the isolated schema and seed data. **Not** the full Supabase schema, but the real column sets, types, defaults and check constraints of every table the three migrations touch, so a function referencing a column the real table lacks fails here. It then executes `20260714000004_ledger_db_enforcement.sql` and `20260827000000_ledger_books.sql` **verbatim**, which is what gives these checks the real deferred balance trigger and the real closed-period triggers rather than a mock of them. `service_role` is created `BYPASSRLS`, as on Supabase, so the migrations' REVOKEs — not RLS — are what the role checks exercise.
- `scripts/check-unified-accounting-migrations.mjs` — correctness. Also runs on PGlite (`PGLITE_MODULE=/private/tmp/portfolio-migration-check/node_modules/@electric-sql/pglite/dist/index.js node scripts/...`), which is useful but cannot show locks between transactions.
- `scripts/check-unified-accounting-concurrency.mjs` — **requires a real server**; it opens several concurrent sessions.

### What the correctness script now covers

Frozen reports (created once, nulls preserved, cross-tenant rows refused, no empty shareable shell, `capital-v1` definition). QuickBooks duplicate refusal. `complete_capital_operation`: per-partner agreement between recipients and journal capital, retry idempotence (no duplicate lines, no duplicate postings), the full input contract (empty / duplicate / foreign / zero / negative / sub-cent / NaN / Infinity), entry-set and tenant scope refusal, **rollback of the lines it had already inserted when finalisation is refused by the closed-period trigger** (and the same request succeeding once the period reopens), the deferred balance trigger, distribution roles, and carry-only publication where the service puts one entry id in both register columns. `discard_unregistered_capital_drafts`: orphan removal, and protection of claimed drafts, posted entries, other source types and other tenants. `finalize_capital_operation`'s recipient requirement. Request-key uniqueness per entity. Settlement review: matching, partial allocation with a confirmed remainder, over-allocation refusal, payment-belongs-to-another-partner refusal, duplicate links, sub-cent amounts, draft payments, tenant refusal, append-only history **checked as `service_role`**, editing an existing review, a refusal leaving the prior decision untouched, and stale allocations releasing their claim. Client-role denial on both tables and all five functions. Legacy column retirement, asserting no register, line, posting or reported LP figure changed.

### What the concurrency script covers (real concurrent sessions)

1. **One draft register, two concurrent publications.** The second blocks on the register row (verified via `pg_stat_activity`, not a sleep), nothing is visible until the first commits, and the second then agrees with what it finds: one set of recipient lines, one posting set, one `issued` register.
2. **One request key, two racing creations.** The loser blocks on the partial unique index, fails, its orphan draft is cleanable while the winner's claimed draft is not, and a retry reuses the winner's register — one key, one call, one posted entry.
3. **One recorded wire, two concurrent reviews.** The second blocks on the advisory lock and is then refused; exactly 80 of an 80 wire ends up allocated.
4. **Two disjoint registers published simultaneously.** No contention, no deadlock.

**Lock ordering.** Both functions take the register row first, then their journal entries ordered by id. `finalize_capital_operation` is only reached from inside `complete_capital_operation`, which already holds both, so there is no reverse-order path today. Any new RPC touching both must take them in that order.

## Defects found and fixed in this session

1. **A stale settlement review could strand a payment permanently.** `review_capital_settlement` counted every other line's allocation against a wire regardless of whether that review still described its line's current manual record. Remove a line's recorded payment and its review becomes stale — but that line can no longer be re-reviewed to release its claim (`manual <= 0` is refused), so nothing could ever match that wire again. The allocation query now only counts reviews that still agree with their line's current `settled_amount`/`settled_on`, which is already how reads treat them (`reconcileSettlements`). Covered by the stale/revival cases in the correctness script.
2. **Over-allocation gave a misleading reason.** Asking to match 90 against an 80 wire said "already allocated" when nothing was. Split into two messages: more than the payment is, versus more than is left of it.
3. **The forecast API and the Analyst reported gross figures as net.** `forecast-section.tsx` applies the vehicle's waterfall whenever capital figures are supported and carry is configured, and headlines the LP's net-of-carry schedule. `construction-service.ts` never called `applyLpWaterfall` and never passed the waterfall to `simulateFund`, so the same fund and date produced a lower TVPI on the page than in the API — in a field named `netIrr`. The service now composes the schedule exactly as the page does, and the response carries `timelineNetOfCarry` plus `grossTimeline` so a reader cannot quote one measure as the other. The Analyst block and the agent tool manifest say which measure they hold. Pinned by two tests in `construction-service.test.ts` that reproduce the page's own composition.
4. **An undated capital posting became a cash flow dated today.** `loadConstructionActuals` defaulted a missing `entryDate` to today for the LP contribution/distribution flows the IRR is computed from — the invented cash-flow date the evidence rules refuse. Undated postings are now dropped. (`journal_entries.entry_date` is NOT NULL, so nothing is discarded in practice.)
5. **A vehicle missing from the registry was a double-post hole.** `vehicleIdByName` returns null for a vehicle with no `fund_vehicles` row. A null `vehicle_id` is not a wildcard: the `request_key` partial unique index cannot dedupe across NULLs, and the retry lookup (`.eq('vehicle_id', null)`) cannot match a NULL row, so each retry would prepare and attempt its own operation. `complete_capital_operation` refused the publication anyway — but only after a draft entry and a register row had been written. `issueCapitalCall`, `declareDistribution` and `POST /api/accounting/settlements` now refuse up front, before provisioning or any write. Pinned in `tests/capital-operation-retries.test.ts`.
6. `tests/capital-operation-retries.test.ts` did not typecheck (a carry-only declaration omitted the required `lines`). Fixed to send `lines: []`, which is what the route sends.

## Implemented locally (unchanged from the previous handoff)

- `capital-evidence.ts`, `capital-source.ts`, `reporting-capital.ts`: shared per-LP evidence resolution, dated commitments, null preservation, reported versus calculated IRR. Matching observations roll forward through continuously reviewed fiscal periods; a gap prevents supersession. Anchor metadata includes observation ID/date and supporting journal IDs. No persisted accounting-mode reader remains in app/lib/scripts (verified again: no reads of `capital_source`, `history_mode`, `sourceByVehicleId`, `isAccounting` or `historyMode` outside the deliberate 410 response in `allocation-terms/route.ts`).
- Fund economics, live LP reports, capital accounts, time series, portal, PDF/Excel, frozen snapshots, and Analyst consumers use shared reporting inputs. Existing called-capital/declared-distribution ratio conventions are intentionally preserved.
- Lazy account provisioning; setup replaced with ordinary Import books / Enter balances / Record transaction actions. Management-company actions avoid the LP opening-balances form. Status no longer returns `source`, `onboarded`, or `historyMode`.
- Import preflight for journal text, bank, and QuickBooks: investment cost/value and LP NAV/contribution/distribution comparisons; possible duplicate bank movements; confirmation tokens invalidate when comparisons change. LP details are permission-gated/redacted in shared import history. Existing investment/LP records are not overwritten. Comparisons include posted books plus this batch, **excluding other drafts**; the UI says so.
- Carry-payment links and ambiguity handling. Calls/distributions prepare draft journals and publish through `complete_capital_operation`.
- Manual settlements retain their original line and cannot be erased by another LP's accounting payment. Unresolved overlaps warn in the capital page and block receipts. `SettlementReviewAction`, `/api/accounting/settlements` (registered `lp_capital`), and `review_capital_settlement` support explicit matching, partial allocations, and confirmed separate remainders. Linked-entry changes reopen review. Decisions have append-only audit history. `capital_settlement_reviews` and `capital_settlement_review_history` are `scope: 'service'` in `table-domains.ts`, service-role-only with no `authenticated` policies, per CLAUDE.md's rule for tables whose only reader is a gated service-role route.
- Forecast page/API/agent share `constructionBaseline`; net availability depends on supported capital values, not journal existence. An unrelated posting does not establish a zero cash balance.
- Ledger pagination errors fail instead of silently truncating.
- Old turn-on/source-switch APIs return 410. Legacy LP-event GET remains for audit; its mutating verbs return 410.

## Remaining work

1. **Authenticated browser workflows.** Nothing here has been exercised through the UI. Cases: empty entity, statement-only fund, partial import, complete books, GP entity, management company, read-only/unauthorized user, import-confirmation differences, and settlement review/editing. Confirm investments and LP records are unchanged after accounting imports. Chrome is at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and puppeteer-core is installed.
2. **Representative comparison on real data.** `scripts/compare-unified-accounting.ts FUND_UUID YYYY-MM-DD` is read-only and reports posted/reported/resolved capital with explanations. Use authorized scoped data only. Every numerical difference must be explained before rollout.
3. **The coverage/supersession design boundary.** Increments 2 and 3 in the plan still have unchecked items: explicit identity/supersession links for statements, opening entries, imported transactions and payment records; fixtures for stale valuations, transfers, unknown fields, mixed currency and incomplete LP populations; and backfilling only unambiguous links. The shipped design derives coverage from existing continuously closed fiscal periods and anchor support rather than adding an import-interval or supersession table. **Assess that boundary explicitly before claiming the evidence design is complete** — do not treat the checked items as the whole of it.
4. **Confirm which migration the user applied, and in which environment.**
5. **Rollout, in this order.** Apply the additive migrations, verify representative scoped comparisons, deploy the unified code, then drop the old columns. Not from local unit tests alone.

## Resolved: the dropped-column window

Kept as the record of what happened, since the convention it produced now lives in `CLAUDE.md`.

**1. The settlement stranding bug was live and is now fixed (`20261006190000` applied).** `review_capital_settlement` as applied counts a stale review's allocation against a wire, and a line whose recorded payment was edited away can never be re-reviewed to release it. Fix: apply **`20261006190000_settlement_review_stale_allocations.sql`**. It is a `create or replace` of that one function, safe on its own, and does not depend on the application deploy. `20261006174407` was reverted to exactly its applied text; the fix lives only in the new file.

**2. `capital_source` and `history_mode` were dropped while the then-committed release still read them.** `20261006174711` is a post-deployment step that was sitting in `supabase/migrations/`, so `db push` correctly applied it along with the rest — the fault is in where the file was, not in how it was run (see the new convention in `CLAUDE.md`). The committed code reads both columns in `capital-source.ts`, `fund-preload.ts`, `lp-positions.ts` and `terms.ts`, and **every one of those reads destructures only `{ data }` and ignores `error`**, so they do not fail — they return the default. On a build of the committed code, both onboarded entities would read as statement-only and `turn-on`/`saveHistoryMode` writes would fail outright, blocking the entities mid-setup.

**The fix was the deploy, not a database repair** — the unified code reads neither column — and it has shipped. Nothing needed restoring: the dropped values are unrecoverable by DDL, and also not needed.

The two scripts written during that window remain, in case the situation recurs:

- `scripts/check-dropped-mode-columns.sql` — read-only, prints a verdict and the affected vehicle count.
- `scripts/restore-mode-columns-shim.sql` — puts the columns back and sets `capital_source = 'ledger'` for the two onboarded vehicles (including inserting a settings row where none exists, since a missing row also reads as `'events'`). Ad-hoc, deliberately not a migration: `20261006174711` is already recorded as applied and re-adding what it dropped should not enter the ledger.

Leave `20261006174711` in place. Deleting an applied migration causes a history mismatch on the next push.

## Fund-of-funds and the schedule of investments

A separate strand from the unified-accounting work, done in the same session. The owner's firm has
21 fund holdings carried **only in the ledger** — each with its own `1100-<id>`/`1200-<id>` accounts
and real postings from a QuickBooks import, and with `fund_capital_events` and
`fund_nav_statements` both entirely empty because the register is still being filled in.

- **The fund-of-funds report is deleted** (`/funds/fof-report`, `/api/accounting/fof-exhibits`,
  `fofSoiPositions`, the nav entry, both access-registry entries, the demo-widget entry). It
  re-derived, firm-wide and unscoped, what the schedule of investments shows per vehicle: every
  entity's page listed every other entity's holdings. `commitmentSchedule`/`performanceTable`
  remain — the LP statement PDF uses them, and its content was deliberately left alone.
- **`loadFofRaw`/`loadFofData` take the vehicle name** and scope the register by it, which fixed
  all five remaining readers at once, including `lp-statement-pdf.ts`.
- **A holding's entity resolves from three sources**, and the ledger is usually the first to
  exist: `fund_holding_terms.vehicle_id`, then the register's `vehicle_id`, then
  `chart_of_accounts` (indexed on `fund_id, vehicle_id, company_id`). Scoping on the register
  alone made a half-entered fund-of-funds invisible on the page used to finish entering it.
- **The schedule of investments generates rows from per-company ledger balances** for holdings the
  portfolio tracker does not cover, keyed on company id so a tracked holding is never duplicated.
  This is what makes those 21 appear by name, and it takes `costVariance`/`fairValueVariance` to
  zero — the "does not tie to the ledger" warning was the symptom of their absence.
- **Underlying funds get their own schedule columns**: Commitment, Called (with % drawn), Unfunded,
  Cost, Fair value, MOIC, NAV as of, % of net assets. `unfunded` is the register's own figure, not
  commitment − called, because a recallable distribution puts capital back on the hook.
- **The fund-side intercompany box is gone.** A charge is already a pair of postings, one per
  entity, so the fund side showed nothing its journal and statements do not. It rendered one panel
  per management company in the firm unconditionally, which is why every fund displayed both.
- **Both fund-holding write paths now carry the entity.** `resolveHoldingVehicle` validates an
  explicitly named one and otherwise infers it; the events and NAV routes no longer default it to
  null, which had made notices unconfirmable (`confirmFundCapitalEvent` refuses an event with no
  vehicle) and left the register unscopeable.

Diagnostics, all read-only and single-statement so the Supabase SQL editor returns them whole:
`scripts/check-fof-vehicle-scope.sql` and `scripts/check-fund-tagged-holdings.sql`.

Open: the 21 include apparent duplicates (`Arden` / `Arden Endeavor Fund LP`, `Cinderpeak Fund III` /
`Cinderpeak Ventures Fund III`, `QRS Digital` / `QRS Digital B, LP`) worth tidying. All carry ledger
postings, so none is safe to delete outright. `loadFofActive` derives the whole fund-of-funds
feature set from `count(companies where holding_type = 'fund') > 0`.

## Migrations and order

**Applied** (all three — do not edit these files in place):

1. `20261006164431_unified_accounting_evidence.sql` — additive. Reporting versions, immutable snapshot RPC, carry links, import-review storage, QuickBooks duplicate protection, atomic capital finalization.
2. `20261006174407_retire_accounting_modes_and_reconcile_payments.sql` — despite its filename, additive only. Settlement-review tables/RPC/audit trail, call/distribution request keys and unique indexes, transactional completion, safe draft cleanup.
3. `20261006174711_retire_accounting_mode_columns.sql` — dropped `capital_source` and `history_mode`. This was the post-deployment step; see **Current state of the database** above.

**Applied since:**

4. `20261006190000_settlement_review_stale_allocations.sql` — the stale-allocation fix. The unified application is committed (`a4008ced`) and deployed, which closed the dropped-column exposure.

**Pending:**

5. `20261006200000_statement_opening_entry_links.sql` — the statement ↔ opening-entry link. Additive: one new table, two functions, and it replaces the per-vehicle `journal_entries_partner_opening_once` index with a per-date one. **Apply this together with a deploy of the code that goes with it**, because the opening-balances route now prepares a draft and calls `publish_opening_balances`: the currently deployed release posts the entry directly, so on the new schema its openings would be posted but unlinked (safe — the resolver falls back to the old inference — but the links would be missing). It does not belong in `supabase/pending-deploy/` because the schema half must land first, not last.

## Environment notes

- A local PostgreSQL 17 test cluster **does work** in this sandbox. The earlier `shmget ... Operation not permitted` failure was a path problem, not a sandbox prohibition: a Unix socket path over 103 bytes makes the server refuse to start, which the long scratch paths produce. Keep the data directory and socket in a short path — `run-unified-accounting-sql-checks.mjs` uses `$TMPDIR/uasql`. Docker remains unavailable.
- Dependencies were restored with `npm ci --ignore-scripts --cache /private/tmp/portfolio-npm-cache`. Use the lockfile; an earlier `npm install --package-lock=false` upgraded Supabase locally and created unrelated type errors. The default npm cache has permission issues; use the temporary cache. The only manifest change in this work is the `sql:check:accounting` script — no dependency or lockfile edits.

## Resume prompt

“Read ACCOUNTING-HANDOFF.md and the current working-tree diff. The SQL and concurrency work is done and `npm run sql:check:accounting` passes; the remaining gaps are authenticated browser workflows, a representative comparison on authorized data, and the coverage/supersession design boundary in increments 2 and 3 of the plan. Verify which migration I applied before rollout. Do not reintroduce accounting modes or claim deployment is complete from local tests.”
