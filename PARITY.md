# Headless parity: the app vs MCP and the API

Audited 2026-10-14 against `main` at a162894. This compares every action a member can take in the web app with what the headless surface can do. The headless surface is the one tool registry served at `/api/mcp` and `/api/agent` (`lib/accounting/agent-tools.ts`, plus `lib/agent/pending-tools.ts` and the dashboard tools). MCP and REST expose the same tools, so the comparison is app vs registry. The two MCP-only gateway tools are the exception. The LP portal has its own MCP (`lib/portal/mcp-tools.ts`), and its rows are judged against that.

**Method.** Every `route.ts` under `app/api` (381 files) was read. Each mutating handler, and each GET that feeds a distinct view, report or export, was traced to the page that calls it. It was then matched to the tool whose handler calls the same `lib` function. *Covered* means a tool does the same thing. *Partial* means a tool exists but lacks options the app has. *Gap* means no tool. *n/a* means it is not a member action that belongs on the headless surface: sign-in, OAuth plumbing, cron, webhooks, the inbound-mail receiver, or retired routes.

## Summary

| Area | Actions | Covered | Partial | Gap | n/a |
|---|---:|---:|---:|---:|---:|
| Accounting: ledger, bank, close, statements | 97 | 36 | 20 | 36 | 5 |
| LP capital, carry, tax, LP relations, management company | 116 | 35 | 17 | 55 | 9 |
| Portfolio: companies, updates, metrics, emails, compliance | 128 | 29 | 22 | 63 | 14 |
| Deal flow and diligence | 66 | 23 | 10 | 33 | 0 |
| Settings, team, approvals, AI usage | 90 | 17 | 10 | 38 | 25 |
| Investor portal (separate portal MCP) | 20 | 8 | 1 | 6 | 5 |
| **Total** | **517** | **148** | **80** | **231** | **58** |

Of the 311 gaps and partials, **25 are deliberate**: secrets, credentials and email-provider setup, outbound email to LPs, the remaining browser-only uploads, deleting all fund data, and cosmetic settings. The other **286 have no recorded reason**. Most are oversights that grew as the app outpaced the registry, and many are small wrappers around `lib` functions that already exist.

## What would most help running the fund headless

These are ranked by how often they block a chat- or script-driven workflow, not by count.

1. **Cleaning up after automation.** The review queue (`/api/review`, resolve) cannot be read or cleared, yet `submit_company_update` sends uncertain figures there. A misrouted email cannot be rerouted. Bank rows cannot be ignored, unposted or restored. A draft journal entry cannot be edited.
2. **Bank matching.** There is no tool to link an inflow to an existing entry (`linkInflowToEntry`), book an outflow as a distribution, run auto-match, or resolve duplicates.
3. **Capital and distributions.** A distribution can only be posted as journal lines: there is no register, carry entry, or waterfall preview. Proposed calls are covered (feat/lp-portal-tools); settlement review has no tool. Issuing a call is now possible (fund-wide pro-rata, this PR).
4. **Intercompany and vendors.** `/api/manco/intercompany` and the vendor list have no tools, and `post_entry` cannot set a vendor. These underpin partnership-expense invoicing, which the receipts work picks up.
5. **Tax season.** None of these have tools: the tax-year close, book-to-tax adjustments, generating K-1 packages, the received-K-1 chase list, and tax forms.
6. **Company and metric upkeep.** There is no tool to edit a company (status, aliases, contact emails), create or delete a metric, or manage default metrics. The `record_investment` schema lacks several types and fields.
7. **Team and access.** Per-area access grants, approving join requests, feature visibility and removing an authorized sender are all app-only. `setup_fund` only adds; removing a member (`remove_member`) needs `AGENT_DESTRUCTIVE_ACTIONS=true`.
8. **Diligence finishing.** No tool exports the memo, runs the partner Q&A interview, deletes or reclassifies a data-room document, or replaces the checklist.

## Closed in this PR

- `issue_capital_call`: stages the existing `issue_capital_call` pending action (fund-wide, pro-rata by commitment) for an admin to approve in the app, from any connection, like `publish_call_notices`.
- `list_runs` and `undo_run`: the Approvals page's *Recent runs* and *Undo*, through `listAgentRuns` and `undoAgentRun`. The same rule as approving applies: the credential that staged a run cannot undo it.
- `discard_drafts`: the journal's bulk discard (`runBulkDraftAction` with `void`). Drafts only.
- `close_period`: the description and schema now say what the handler does (close through a date, month by month). The old text promised a `periodStart`/`periodEnd` range lock.

## Closed in feat/lp-portal-tools

- LP onboarding and outreach, previously listed as deliberately web-only: `lp_portal_accounts`, `lp_portal_invite`, `lp_portal_invite_bulk` (including a `missing` mode that invites every LP with a contact email and no portal account, previewed first), `lp_portal_account_status`, `lp_portal_resend_invite`, `lp_portal_unlink`, `lp_authorized_users`, `lp_authorized_user_add`, `lp_authorized_user_remove`, `lp_announce`, `lp_send_item_recipients`, `lp_send_item` and `lp_portal_settings`. All admin-only (`ADMIN_ONLY_TOOLS`); every email has a preview that changes nothing.
- Proposed capital calls: `lp_proposed_calls`, `lp_proposed_call_propose`, `lp_proposed_call_revise`, `lp_proposed_call_discard` and `lp_proposed_call_approve`. All four writes are admin-only. Approving issues the call and publishes its notices, as the app's button does.
- The two parts that stayed web-only because `/api/mcp` ships no headless Chromium now run from chat. `lp_send_item` attaches a statement or letter PDF, fetched from `/api/agent/reports/<token>` with a signed link (`lib/agent/remote-pdf.ts`). `lp_proposed_call_approve` and an approved `publish_call_notices` publish through `/api/agent/call-notices/publish`, using a signed token that the route re-checks live (`lib/agent/notice-publish-link.ts`). An admin can approve `publish_call_notices` from chat with `approve_action`; a script's key cannot.

## Closed in feat/agent-uploads

- **Uploads without passing the file through chat.** Each `*_upload_url` tool returns a two-hour signed Supabase Storage upload URL at a server-chosen path, with the exact `curl -X PUT` form, headers and size limit; the assistant uploads the file from the person's folder and a register tool takes it in through the web route's own function (now in `lib/`). `diligence_document_upload_url` (then `diligence_add_documents` with `uploaded_files`), `company_document_upload_url` + `add_company_document`, `deals_deck_upload_url` (then `deals_create_inbound`), `company_update_upload_url` (then `submit_company_update`), `email_attachment_upload_url` + `add_email_attachment`, and `lp_document_upload_url` + `lp_add_document` (admin-only). URL tools change no record and run directly (`runsDirectly`); register tools stage from a chat. `entity_document_upload_url` now runs directly too (it was staged from a chat, so the URL never reached it).
- **The server's model from chat.** `company_generate_summary` (the Summarise button's `generateCompanySummary`) and `portfolio_import_preview` (the AI import's `parsePortfolioImport`, returned as a proposal, nothing written). Both refuse with no server key and name the chat tools to use instead.

## Deliberately not on the headless surface

Each of these is a choice, with its reason. Revisit one only if the reason no longer holds.

**Update (destructive admin changes):** deleting a company, an LP investor, entity or commitment event, a diligence deal or a dated set of LP positions, removing a team member, unposting, reversing or voiding a posted entry, reopening periods, and merging investors or vehicles are now tools, offered only when the deployment sets `AGENT_DESTRUCTIVE_ACTIONS=true` and always staged for an admin's approval (DOCS, "Deletes, merges and undoing the books"). Deleting all fund data stays out.

**Update:** secrets no longer need the web app either. Every key can be set in the deployment's environment (`.env`), `environment_status` says which are set, and `update_fund_connections` sets the non-secret provider choices from chat. See DOCS, "Keys in the environment".

| Area | Action | Reason |
|---|---|---|
| acct-capital-tax | Sort a batch of uploaded onboarding docs and confirm filing | deliberate: browser-only file upload batch (signed upload to lp-documents) |
| acct-core | Preview / apply / revert LP-snapshot cutover to capital events (fund-wide) | deliberate-ish: one-off fund-wide migration, admin-only (DELETE in admin-only list) |
| acct-core | LP closings: list/add/rename/redate/set members/delete | deliberate: add_partner comment 'admission to a closing stays a decision for the UI'; POST/DELETE admin-only |
| portfolio | Save email attachments to Google Drive | deliberate-ish: depends on fund's Google OAuth credential; low value for an agent with its own Drive connector |
| settings-admin | Upload/remove fund logo | deliberate-ish: image payload (data:image URL up to 200KB) not a natural tool arg; UI cosmetic |
| settings-admin | Set/replace AI provider API keys (Claude, OpenAI, OpenRouter) | deliberate: credential/secret should not pass through a chat (setup-tools.ts WEB_ONLY ai_key note; setup_fund says never pass keys) |
| settings-admin | Configure outbound email provider and its keys (Resend key, Postmark server token, Mailgun API key) | deliberate: credentials + third-party account setup |
| settings-admin | Configure inbound email (provider, Postmark inbound address, Mailgun inbound domain, signing key, webhook token) | deliberate: needs Postmark/Mailgun account + webhook + signing secret (setup-tools.ts WEB_ONLY inbound_email). NOTE: prerequisite for the planned emailed-receipts flow |
| settings-admin | Set Google Drive OAuth client id/secret | deliberate: credential |
| settings-admin | Choose file storage provider | deliberate-ish: infra choice coupled to Drive OAuth connection, which is browser-only |
| settings-admin | Set analytics IDs (Fathom, GA) and custom head script | deliberate: custom head script is arbitrary script injection into every page; agent must not set it. IDs are UI-only |
| settings-admin | Delete all fund data | deliberate: admin-only, irreversible, destructive. Not offered even with `AGENT_DESTRUCTIVE_ACTIONS=true`, which brings the other destructive admin changes to chat (see below) |
| settings-admin | Generate/revoke public deal submission link | deliberate-ish: mints a bearer-style public URL (shown once); reasonable to keep in browser |
| settings-admin | Upload a style-anchor memo | deliberate-ish: file upload (signed URL); the signed-upload pattern (lib/uploads/signed-upload.ts) now covers data rooms, company documents, decks, email attachments and LP documents, so this one could follow it |
| settings-admin | Configure inbound email / Postmark during onboarding | deliberate: third-party credentials + webhook (same as settings inbound row) |
| portal(LP) | Upload onboarding document | deliberate: browser-only file upload ('a file is not something to hand an assistant', lib/portal/mcp-tools.ts header) |
| portal(LP) | Withdraw an uploaded onboarding document | deliberate-ish: tied to uploads, which stay on web |
| portal(LP) | Give e-K-1 electronic delivery consent | deliberate-ish: legal e-delivery consent should be given by the person (no explicit rationale in code) |
| portal(LP) | Manage authorized users (advisors) on my account | deliberate-ish: delegation/access control |

## Every gap and partial, by area

Effort is a guess: S is a tool wrapping an existing `lib` function, M needs logic moved out of a route first, and L is new behaviour. *easy-win* marks the S items.

### Accounting: ledger, bank, close, statements

| Action | Route | Status | Nearest tool | Reason | Fix | Effort |
|---|---|---|---|---|---|---|
| 1099 vendor payments worksheet | `vendor-payments(GET)` | gap | - | no reason found | wrap loadVendorPayments | S easy-win |
| Audit trail (who changed what, CSV) | `audit-log(GET)` | gap | - | no reason found | wrap loadAuditTrail+visibleTo | S easy-win |
| Auto-match drafted rows to declared capital calls (1300) / distributions (2300) | `bank/auto-match(POST)` | gap | - | no reason found - likely oversight | auto_match_bank tool wrapping autoMatchOpenCapital(admin,fundId,group,userId,ids?) | S easy-win |
| Backfill investment entries into the ledger (dry-run / all vehicles) | `investments(POST action=backfill)` | gap | - | no reason found (writes postings; could be staged) | backfill_investments tool wrapping backfillDerivedEntries / backfillAllVehicles with dryRun | S easy-win |
| Book an inflow as a capital call (pro-rata or to one LP) | `bank/match(POST default)` | partial | book_capital_call | tool has no lpEntityId (single-partner) option | pass lpEntityId through to bookCapitalCallFromInflow | S easy-win |
| Book an outflow as a distribution (pro-rata, perLp map, or one LP) | `bank/match(POST mode=distribute)` | gap | - | no reason found - likely oversight | book_distribution_from_bank wrapping bookDistributionFromOutflow | S easy-win |
| Browse journal (filters: period preset, status draft/posted/void, search text, adjusting, tax book, single entry by id) | `journal(GET)` | partial | list_journal; query_ledger | list_journal only takes start/end; no status filter (returns void+draft+posted mixed), no search, no adjusting, no ?book=tax, no get-by-id | add status/search/adjusting/book/id params to list_journal | S easy-win |
| Create a journal entry (manual, with vendor/payee, reference, adjusting flag, draft or posted) | `journal(POST)` | partial | post_entry; post_ledger_text | post_entry has no vendorId, reference, adjusting or sourceRef; currency taken from input not fund currency | add vendorId/reference/adjusting to post_entry; use fundCurrency | S easy-win |
| Create suggested draft entries for an open period (accruals etc.) | `periods(POST action=createSuggestedDrafts)` | gap | - | no reason found - likely oversight | tool wrapping createSuggestedDrafts(admin,fundId,group,userId,start,end,ids) | S easy-win |
| Entity family / intercompany view | `firm/family(GET)` | gap | - | no reason found (relevant to intercompany/partnership-expense invoicing) | wrap loadFamilyIntercompany | S easy-win |
| Entity status: onboarding, close position, needs-attention list | `status(GET)` | partial | setup_status; close_status; whats_due | no per-entity attention list | entity_status tool wrapping vehicleStatus | S easy-win |
| Fee links: remove | `forecast/fee-links(DELETE)` | gap | - | no reason found - likely oversight | tool wrapping deleteFeeLink | S easy-win |
| Financial statement package for a period (BS, IS, TB, cash flows, SOI, capital) | `statements(GET)` | partial | financial_statements; show_financial_statements | financial_statements is inception-to-date only, no period window, no cash-flow/SOI/capital sections | call buildStatementPackage with preset/start/end | S easy-win |
| Firm overview (all entities, backlog) | `firm(GET)` | partial | list_vehicles; close_status | no single firm overview | wrap loadFirmOverview | S easy-win |
| Firm-wide bank view (all entities) | `bank/firm(GET)` | partial | list_bank_transactions (per vehicle) | no cross-entity view | firm_bank tool wrapping loadFirmBank | S easy-win |
| Firm-wide drafts awaiting post | `firm/drafts(GET)` | gap | list_journal (per vehicle, no status filter) | no reason found | wrap loadFirmDrafts | S easy-win |
| Fund growth time series (quarterly cumulative, NAV composition) | `fund-timeseries(GET)` | gap | - | no reason found | wrap fundTimeseries | S easy-win |
| Fund performance report (LP-only, groupBy, as-of) | `fund-performance(GET)` | partial | fund_performance_pdf | PDF only; no JSON of the ledger report | wrap fundPerformance+performanceParams | S easy-win |
| Fund-wide economics per vehicle (from ledger, with as-of IRR) | `fund-economics(GET)` | partial | fund_performance; show_portfolio_dashboard | fund_performance reads LP register not ledger, no as-of/IRR; dashboard is visual only | fund_economics tool wrapping fundEconomics(admin,fundId,asOf) | S easy-win |
| LP positions (tracking vehicles): view | `positions(GET)` | partial | lp_capital_summary; lp_list_snapshots | not the dated lp_positions grid | wrap loadPositions | S easy-win |
| Link a bank inflow to an existing journal entry | `bank/match(POST mode=link)` | gap | - | no reason found - likely oversight (key for 'match receipt/bank row to existing JE') | link_bank_transaction tool wrapping linkInflowToEntry | S easy-win |
| Link an investment entry to a bank row | `investment-bank-match(POST)` | gap | - | no reason found | wrap matchInvestmentToBank | S easy-win |
| List investment entries lacking a bank row, with candidates | `investment-bank-match(GET)` | gap | - | no reason found | wrap unbankedInvestments | S easy-win |
| Preview a close through a date (month-by-month allocation) | `periods(POST action=preview)` | gap | allocation (post:false single action) | no reason found - an agent closes blind | close_preview tool wrapping previewCloseThrough | S easy-win |
| QuickBooks: create investment cost accounts for discovered companies | `quickbooks/mapping/discover(POST)` | gap | - | no reason found | wrap ensureInvestmentAccounts | S easy-win |
| QuickBooks: import history | `quickbooks/import(GET)` | gap | - | no reason found | small read tool | S easy-win |
| QuickBooks: tie out trial balance vs QB TB | `quickbooks/tie-out(POST)` | gap | - | no reason found | tool wrapping parseQbTrialBalance+compareTrialBalance+trialBalance | S easy-win |
| Realized gains by lot (Schedule D / 8949 input) | `realized-gains(GET)` | gap | tax_package_zip (file) | no reason found | wrap loadRealizedGains | S easy-win |
| Reconcile capital accounts: prefill admin figures from LP snapshot | `reconciliation(GET)` | gap | - | no reason found | add prefill to reconcile tool | S easy-win |
| Rename an account / hide-show an account | `chart(PATCH)` | gap | - | no reason found - likely oversight | update_account tool: {code, name?, isActive?}; port the inline PATCH logic (refuses per-partner capital accounts) | S easy-win |
| See capital-call candidates for an inflow | `bank/match(GET)` | gap | - | no reason found | include in a match tool via capitalCallCandidates | S easy-win |
| Seed/backfill the default chart for an entity | `chart(POST, no account)` | partial | setup_fund (charts on entity creation); list_accounts GET path auto-seeds via chart route only | agent list_accounts does not call ensureVehicleAccounts; setup_fund seeds new entities only | have list_accounts (or add_account with seed:true) call ensureVehicleAccounts | S easy-win |
| Vendors: create (or find by name) | `vendors(POST)` | gap | - | no reason found | add_vendor wrapping ensureVendor | S easy-win |
| Vendors: list | `vendors(GET)` | gap | - | no reason found - needed for expense/receipt tagging | list_vendors wrapping listVendors | S easy-win |
| Vendors: update (1099 eligible, TIN on file, notes) | `vendors(PATCH)` | gap | - | no reason found | update_vendor tool | S easy-win |
| View account register (balance in, lines with counter-accounts, running balance) | `ledger(GET)` | partial | query_ledger | query_ledger filters lines but has no carried-in/running balance | account_register tool wrapping accountRegister+loadPostedLedger | S easy-win |
| View allocation entries a closed period posted | `periods(GET ?entriesFor)` | partial | list_journal (filter by date) | no direct lookup | add periodId to list_periods/loadCloseEntries | S easy-win |
| Void a draft (discard) or void a posted entry (reason, admin-only) | `journal(PATCH action=void)` | covered | discard_drafts (drafts); void_entry (posted only; refuses a draft and points to discard_drafts) | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve | - | - |
| Approve (sign off) prepared close review | `periods(POST action=approve)` | partial | approve_close | tool takes a through date; route also accepts a single period id + attestation | add id/attestation params | S |
| Book per-LP opening capital balances (cutover entry) | `opening-balances(POST)` | partial | post_entry (manual equivalent) | no dedicated tool; logic inline in route (capital accounts ensured, offset 1000) | move to lib/accounting/opening-balances.ts + tool | M |
| Download chart of accounts CSV | `chart/export(GET)` | partial | list_accounts | data available, no file | none needed (agent gets JSON) | - |
| Download statement workpaper (.xlsx) | `statements/export(GET)` | gap | - | no reason found; file download | report-link tool like financial_statements_pdf | S |
| Edit a DRAFT entry (date, memo, lines, payee) | `journal(PUT)` | gap | - | no reason found - likely oversight (agent can only void+recreate, and void is also missing) | update_draft_entry tool; extract PUT body into lib (journal-edit.ts) and call it | M |
| Export journal as CSV / XLSX / QuickBooks-layout CSV | `journal/export(GET)` | partial | list_journal; export_ledger_text | no file/link; QuickBooks layout not available | report-link style download URL (like financial_statements_pdf) | S |
| Forecast export CSV / XLSX model | `forecast/export(GET)` | partial | forecast_series (data) | no file/xlsx model | report-link download | S |
| Ignore a bank row (voids its entry; reason if posted) | `bank(POST action=ignore)` | gap | - | no reason found - likely oversight (posted-row ignore voids books, could be staged) | ignore_bank_transaction tool; move inline logic into bank-actions.ts | M |
| LP positions: edit one LP on a date | `positions(PUT)` | gap | - | no reason found | tool porting inline upsert | S |
| LP positions: paste/import spreadsheet | `positions/import(POST)` | gap | - | no reason found (AI paste route; agent could pass parsed rows) | tool taking rows; logic inline in route - extract | M |
| Resolve a suspected duplicate (link to QuickBooks/investment entry or keep separate) | `bank/duplicates(POST)` | gap | - | no reason found; logic inline in route | move to lib (bank-duplicates.ts) + resolve_bank_duplicate tool | M |
| Restore an ignored bank row | `bank(POST action=restore)` | gap | - | no reason found - likely oversight | same as above | M |
| State tax worklist | `state-worklist(GET)` | gap | - | no reason found (needs carry access check) | wrap buildStateWorklist | S |
| Unpost a posted bank row back to draft | `bank(POST action=unpost)` | gap | - | no reason found; voids/unposts an entry (reason+audit) | add to bank-actions.ts + tool, or stage | M |
| View bank feed with review kinds and match candidates | `bank(GET)` | partial | list_bank_transactions | agent list has no review kind, QuickBooks/investment duplicate candidates, or categorization detail | add candidates/reviewKind to list_bank_transactions | M |
| View tracked positions vs what the ledger carries (gap to book) | `investments(GET)` | partial | portfolio_summary | no ledger-vs-tracker comparison | wrap ledgerByCompany/buildSoiPositions | S |
| Wire instructions / call-notice period for an entity | `vehicle-settings(GET/PATCH)` | gap | - | no stated reason; wire details are a payment-fraud vector and notice period is admin-only - reasonable to keep human or stage | read tool + staged write | S/M |
| LP closings: list/add/rename/redate/set members/delete | `closings(GET/POST/PATCH/DELETE)` | gap | add_partner (no closing) | deliberate: add_partner comment 'admission to a closing stays a decision for the UI'; POST/DELETE admin-only | staged closing actions if wanted | M |
| LP positions: delete a dated set | `positions(DELETE)` | covered | delete_lp_positions | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve | - | - |
| Preview / apply / revert LP-snapshot cutover to capital events (fund-wide) | `cutover(GET/POST/DELETE)` | gap | - | deliberate-ish: one-off fund-wide migration, admin-only (DELETE in admin-only list) | preview tool is a safe easy-win (previewCutover); apply via staged action | S/M |
| Reopen closed period(s) (reason, admin-only) | `periods(POST action=reopen)` | covered | reopen_period | Always offered; admin-only, so staged for an admin from chat | - | - |
| Reverse a posted entry with a dated contra-entry (reason, admin-only) | `journal(PATCH action=reverse)` | covered | reverse_entry | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve | - | - |
| Unpost a posted entry back to draft (reason required) | `journal(PATCH action=unpost)` | covered | unpost_entry | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve | - | - |

### LP capital, carry, tax, LP relations, management company

| Action | Route | Status | Nearest tool | Reason | Fix | Effort |
|---|---|---|---|---|---|---|
| Attribute pooled LP capital to per-LP capital accounts (preview + apply, onboarding step) | `/api/accounting/attribute-lp-capital (POST)` | gap | - | No reason found; one-time onboarding/migration step, low agent value | Tool wrapping previewAttributeLpCapital / attributeLpCapital (dryRun flag) | S easy-win |
| Close a tax year | `/api/accounting/tax-year (POST action=close)` | gap | close_period (book periods only) | No reason found; close_period is the book lock, not the tax lock | close_tax_year tool (closeTaxYear) | S easy-win |
| Delete an LP letter | `/api/lp-letters/[id] (DELETE)` | gap | - | No reason found (not admin-only) | lp_delete_letter tool | S easy-win |
| Edit a letter (draft, narratives, status, prompts) | `/api/lp-letters/[id] (PATCH)` | partial | lp_write_letter | Tool sets full_draft, sections, mark final; cannot revert to draft or edit generation_prompt/company_prompts | Pass through status/generation_prompt/company_prompts to updateLetter | S easy-win |
| Generate a draft K-1 package | `/api/accounting/k1-packages (POST action=generate)` | gap | - | No reason found - likely oversight (draft is non-destructive) | k1_generate tool calling generateK1Package | S easy-win |
| Mark a received K-1 (received / amended / not owed) | `/api/accounting/received-k1s (POST)` | gap | - | No reason found; natural fit for inbound-email K-1 flow | mark_received_k1 tool (upsert received_k1s row) | S easy-win |
| Mark an LP message thread open/resolved | `/api/lps/messages (PATCH)` | gap | - | No reason found | lp_resolve_message tool | S easy-win |
| Post an intercompany charge (mgmt fee, expense reimbursement, allocated cost, loan) between manco and a fund | `/api/manco/intercompany (POST)` | gap | post_entry (one vehicle's journal only) | No reason found. post_entry cannot post the mirrored two-book entry + register row that postIntercompanyCharge writes. | post_intercompany_charge tool calling postIntercompanyCharge (direction receivable/payable) | S easy-win |
| Post book-to-tax adjustments | `/api/accounting/tax-adjustments (POST)` | gap | - | No reason found - likely oversight | same tool with post:true | S easy-win |
| Preview a distribution split (waterfall or pro-rata) | `/api/accounting/distributions (POST action=preview)` | partial | run_waterfall (pure calc, terms passed in) | run_waterfall needs caller-supplied terms/state; does not read the vehicle's carry terms or capital like previewDistribution | preview_distribution tool calling previewDistribution | S easy-win |
| Preview a pro-rata capital call split | `/api/accounting/capital-calls (POST action=preview)` | gap | - | proRataCall is used only by the in-app Analyst's staged issue_capital_call, which is not on the MCP/REST registry. Likely oversight. | Expose proRataCall as preview_capital_call read tool | S easy-win |
| Preview book-to-tax adjustments for a year | `/api/accounting/tax-adjustments (GET)` | gap | - | No reason found | tax_adjustments tool (postTaxAdjustments preview:true) | S easy-win |
| Propose / revise / discard a capital call proposal | `/api/accounting/proposed-calls (POST action=propose\|revise\|discard)` | covered | lp_proposed_call_propose; lp_proposed_call_revise; lp_proposed_call_discard (admin-only, as the route) | Closed in feat/lp-portal-tools | - | - |
| Read LP inbox messages and replies | `/api/lps/messages (GET)` | gap | - | No reason found - likely oversight | lp_messages read tool | S easy-win |
| Record a carry payment to a GP member | `/api/accounting/gp-economics (POST)` | gap | - | Admin-only; no tool | record_carry_payment tool (recordCarryPayment), staged | S easy-win |
| Review a settlement: link wires to an obligation line, split remainder | `/api/accounting/settlements (POST)` | gap | reconcile; book_capital_call (adjacent) | No reason found - likely oversight | review_settlement tool calling the review_capital_settlement RPC | S easy-win |
| Set a GP member's ownership or carry weight | `/api/accounting/gp-economics (PUT)` | gap | - | Admin-only; no tool. Likely oversight (could be staged). | set_gp_economics tool (setOwnershipWeight/setCarryWeight), staged | S easy-win |
| Set a partner's allocation term (participates in fees/expenses/carry, weight or rate override) | `/api/accounting/allocation-terms (POST action=term)` | gap | allocation (per-call overrides only) | No reason found - likely oversight. allocation tool accepts one-off per-LP rateOverride/exempt but nothing persists the term. | Same set_allocation_terms tool calling savePartnerTerm | S easy-win |
| Set the vehicle's allocation basis (commitment vs capital balance) | `/api/accounting/allocation-terms (POST action=basis)` | gap | - | No reason found - likely oversight (allocation tool consumes the basis but cannot set it) | set_allocation_terms tool calling saveAllocationBasis | S easy-win |
| Set which LPs see the live report in their portal | `/api/lps/live-report/share (GET/POST)` | gap | - | Admin-only publish to LPs; lp_share_letter shows the same pattern is allowed for letters - inconsistent | lp_share_live_report tool mirroring lp_share_letter | S easy-win |
| Settle an intercompany charge | `/api/manco/intercompany (POST action=settle)` | gap | - | No reason found | settle_intercompany_charge tool (settleIntercompanyCharge) | S easy-win |
| Switch a partner's class between GP and LP | `/api/accounting/lps (PATCH)` | gap | - | No reason found - likely oversight | set_partner_class tool: update partner_class + applyPartnerClassTerms | S easy-win |
| View GP/associate entity economics (ownership %, carry points, accrued/paid/unpaid) | `/api/accounting/gp-economics (GET)` | gap | - | No reason found - likely oversight | gp_economics read tool calling loadGpEconomics | S easy-win |
| View K-1 packages for a vehicle/year | `/api/accounting/k1-packages (GET)` | partial | schedule_k_pdf (resolves latest package) | No list of packages/versions/status/blockers; schedule_k_pdf only fetches one partner's PDF | k1_packages read tool | S easy-win |
| View K-1s owed to us by fund holdings (chase list) | `/api/accounting/received-k1s (GET)` | gap | compliance_calendar / whats_due (dates only) | No reason found - likely oversight | received_k1s read tool (loadK1Dependencies) | S easy-win |
| View LP onboarding checklist / facts / history | `/api/lps/onboarding (GET); /onboarding/facts (GET); /onboarding/history (GET)` | gap | - | No reason found | lp_onboarding_status read tool | S easy-win |
| View LP portal accounts and invite status | `/api/lps/invites (GET)` | covered | lp_portal_accounts | Closed in feat/lp-portal-tools (admin-only, as the route) | - | - |
| View LP portal activity log (logins, views, downloads) | `/api/lp-activity (GET)` | gap | - | No reason found; feature-gated admin view | lp_portal_activity read tool | S easy-win |
| View allocation basis, partner terms and current commitments | `/api/accounting/allocation-terms (GET)` | partial | lp_commitments; capital_accounts | Commitments are readable; allocation basis and per-partner fee/carry terms (participates, weight/rate overrides) are not exposed by any tool. No reason found - likely oversight. | Add allocation_terms read tool wrapping loadResolvedCommitments + terms loader | S easy-win |
| View capital settlements (payments matched to call/distribution lines) and reviews | `/api/accounting/settlements (GET)` | partial | query_lps(capital_call_lines) (funded/outstanding only) | No payment-link detail or review state | settlements read tool (loadSettlements + loadSettlementReviews) | S easy-win |
| View carry (waterfall) terms | `/api/accounting/waterfall-terms (GET)` | gap | - | No reason found (run_waterfall makes the caller supply terms) | carry_terms read tool (loadCarryTerms) | S easy-win |
| View declared distributions | `/api/accounting/distributions (GET)` | gap | - | No reason found; listDistributions not wrapped (capital_accounts shows only aggregate distributions) | lp_distributions read tool calling listDistributions | S easy-win |
| View intercompany charge register and balances | `/api/manco/intercompany (GET)` | gap | - | No reason found - likely oversight. Central to the owner's quarterly partnership-expense invoicing goal. | intercompany_charges read tool (listIntercompanyCharges + intercompanyBalances) | S easy-win |
| View management company overview (cash, quarterly cycle, expense breakdown, intercompany balances) | `/api/manco/overview (GET)` | partial | financial_statements; query_ledger | Statements available per manco vehicle, but not the assembled overview (cycle, intercompany balances) | manco_overview read tool calling loadMancoOverview | S easy-win |
| View partners' tax form (W-9/W-8) standing | `/api/accounting/tax-forms (GET)` | gap | - | No reason found | tax_forms read tool | S easy-win |
| View proposed capital calls (list / one, re-checked) | `/api/accounting/proposed-calls (GET)` | covered | lp_proposed_calls | Closed in feat/lp-portal-tools | - | - |
| View tax-year state (what a close is waiting on) | `/api/accounting/tax-year (GET)` | gap | - | No reason found | tax_year_status read tool (taxYearState) | S easy-win |
| View/create/edit/delete letter templates (style guide) | `/api/lp-letters/templates (GET/POST); /templates/[id] (GET/PATCH/DELETE)` | gap | lp_draft_letter (uses template by id) | No reason found; templates can be chosen but not managed | lp_letter_templates list/save tools | S easy-win |
| Batch export LP report cards as a ZIP of PDFs | `/api/lps/export/pdf (POST)` | partial | lp_report_card_pdf (one investor) | One investor per call; no batch zip | Loop lp_report_card_pdf or add zip report-link kind | S |
| Declare a distribution (lines, carry lines, tiers, character, deductions, imported payments) | `/api/accounting/distributions (POST action=declare)` | partial | allocation(action=distribution) (journal only) | allocation posts per-LP distribution journal lines but creates no distribution register, carry entry, character or notice lines. Admin-only; no staged pending action exists. Likely oversight. | declare_distribution tool, staged (add pending action wrapping declareDistribution) | M |
| Delete a carry payment | `/api/accounting/gp-economics (DELETE)` | gap | - | Admin-only, destructive | Optional, staged (deleteCarryPayment) | S |
| Download K-1 workbook for the preparer | `/api/accounting/k1-packages/export (GET)` | partial | tax_package_zip (includes K-1 workbook when final) | Only bundled inside tax package zip and only for a final package; no standalone or draft workbook link | Add report-link kind for buildK1WorkbookForPackage | S |
| Email LPs asking for outstanding onboarding items | `/api/lps/onboarding/request (POST)` | gap | - | Outbound email to LPs | staged request tool (preview first) | M |
| Export all LP investors/positions to Excel | `/api/lps/export/excel (POST)` | partial | lp_live_report; query_lps(lp_positions) | Data available as JSON, no xlsx file link | Add report-link kind for the Excel export | S |
| Export letter as Markdown / DOCX / Google Docs | `/api/lp-letters/[id]/export (POST)` | partial | lp_letter (markdown text); lp_letter_pdf | PDF and raw text available; no DOCX or Google Docs export | Add report-link kind for buildDocxBuffer | S |
| Finalize or amend a K-1 package | `/api/accounting/k1-packages (POST action=finalize\|amend)` | gap | - | Admin-only; issuing tax documents. Defensible to keep in app but could be staged. | k1_finalize/k1_amend tools with stagesAs (finalizeK1Package/amendK1Package) | M |
| Issue a capital call (lines, per-LP or fund-wide, charges, advances applied, imported payments) | `/api/accounting/capital-calls (POST action=issue)` | partial | issue_capital_call (this PR, staged for an admin) | The tool issues a fund-wide pro-rata call, the Analyst's pending action. Per-LP lines, charges and applied advances are still app-only: no lib function takes them outside the route. | Extend the issue_capital_call action with lines and charges. | M |
| List LP documents / delete one | `/api/lps/documents (GET/DELETE)` | gap | - | List: oversight. Delete: admin-only destructive. | lp_documents read tool; delete staged | S |
| Preview a proposed call's notice PDF for one partner | `/api/accounting/proposed-calls/pdf (GET)` | gap | - | No reason found | Add report-link kind for proposedNoticePdf | S |
| Preview the portal as a given investor / open their snapshot PDF or document | `/api/lps/preview (GET); /preview/snapshot/[id]/pdf (GET); /preview/document/[id] (GET)` | partial | lp_report_card_pdf; lp_snapshot_pdf; lp_letter_pdf | Individual documents reachable, no 'what this LP sees' view or uploaded-document download | lp_portal_view read tool | M |
| Publish call/distribution notices to portals and optionally email them | `/api/accounting/notices/publish (POST)` | partial | preview_call_notices; publish_call_notices (staged; an admin approves it in the app or from chat with approve_action) | The tool covers capital-call notices to the portal only, and is always staged. There are no distribution notices, no regenerate and no email. Since feat/lp-portal-tools an admin's chat can approve it: the publish runs on `/api/agent/call-notices/publish`, which ships Chromium. Not present on the live connection (older tool list version). Email deliberately excluded ('It emails no one'). | Add kind=distribution to the staged action; keep email in the app or stage it separately | M |
| Publish capital account statements to LP portals (PDF per partner) | `/api/accounting/lp-statement/publish (POST)` | gap | - | Admin-only and goes out to LPs; no staged equivalent. Deliberate-ish (publishing kept in app) but publish_call_notices shows the staged pattern exists. | publish_lp_statements tool with stagesAs pending action | M |
| Record a partner's tax form with document | `/api/accounting/tax-forms (POST)` | gap | - | partly deliberate: needs an uploaded document (lp-documents bucket, browser upload) and TIN handling | record_tax_form tool accepting an already-uploaded documentId (pair with an LP-document upload URL tool) | M |
| Regenerate one company's section with AI | `/api/lp-letters/[id]/generate/[companyId] (POST)` | partial | lp_write_letter(sections) + lp_letter_data | Agent can write the section itself; no server-side AI regen of one company | Acceptable (agent writes it) | - |
| Reopen a closed tax year | `/api/accounting/tax-year (POST action=reopen)` | gap | - | Admin-only; defensible to keep in app or stage | staged reopen_tax_year (reopenTaxYear) | S |
| Reply to an LP message (emails the LP) | `/api/lps/messages (POST)` | gap | - | Outbound email to LPs; plausible to stage | staged lp_reply_message | M |
| Review an onboarding item (verify/reject/waive, attach doc, record tax form) | `/api/lps/onboarding (PATCH)` | gap | - | No reason found; doc attach needs browser upload | lp_review_onboarding tool | M |
| Send capital-call receipts for funded lines (preview, portal, email) | `/api/accounting/notices/receipt (POST)` | gap | - | Goes out to LPs (email); no tool or staged action | preview via receiptCandidates as read tool; send staged (sendReceipts) | M |
| Set carry (waterfall) terms | `/api/accounting/waterfall-terms (PUT)` | gap | - | Admin-only; changes carry accrual. Defensible but could be staged. | set_carry_terms tool, staged | M |
| Set the fund's required onboarding document kinds | `/api/lps/onboarding (PUT)` | gap | - | Settings-like; no reason found | Optional tool | S |
| Upload an LP document (signed URL) and record/share it (fund, investor or vehicle scope) | `/api/lps/documents/upload-url (POST); /api/lps/documents (POST)` | covered | lp_document_upload_url; lp_add_document (both admin-only) | Closed in feat/agent-uploads: signed URL in the fund's folder, then lib/lps/documents.ts recordLpDocument (scan, share by scope, index), the route's own function | - | - |
| View K-1 furnishing plan (electronic vs paper, consent status) | `/api/accounting/k1-deliveries (GET)` | gap | - | No UI caller yet (feature not surfaced in app); parity not required | Revisit when UI ships | - |
| View capital-account roll-forward (period + ITD, IRR, advances, stranded capital) | `/api/accounting/capital-accounts (GET)` | partial | capital_accounts; lp_statement; lp_capital_summary | capital_accounts gives ITD roll-forward + NAV only; no statement-period column, IRR, advance balances or stranded-capital warnings (lp_statement covers one LP with periods) | Add period/start/end and irr to capital_accounts using resolvePeriod + reportingIrr | S |
| View deal-by-deal (American) carry entitlement | `/api/accounting/deal-carry (GET)` | gap | run_waterfall (European only, pure calc) | No reason found - likely oversight | Move the route's assembly into lib (dealByDealCarry over txnsForVehicle + capital accounts) and expose deal_carry read tool | M |
| View/add/remove GP links (which entity is GP of a vehicle, as which partner) | `/api/accounting/vehicle-gp-links (GET/POST/DELETE)` | gap | - | No reason found; setup-type config. DELETE admin-only. | gp_links tool (list/add; remove staged) | S |
| View/create/edit/delete legacy LP snapshots (reports) | `/api/lps/snapshots (GET/POST/PUT/DELETE)` | partial | lp_list_snapshots; lp_snapshot (read) | Reads covered; writes have no UI caller (legacy), DELETE admin-only | n/a for writes | - |
| View/set live LP report card header and footer | `/api/lps/live-settings (GET/PUT)` | gap | - | UI-only cosmetic | Optional | S |
| Approve a proposed call (issues it + publishes notices) | `/api/accounting/proposed-calls (POST action=approve)` | covered | lp_proposed_call_approve (admin-only) | Closed in feat/lp-portal-tools. Like the app's button, it issues the call and then publishes each LP's notice, returning the published, reused and error counts. The notices render on `/api/agent/call-notices/publish` (which ships Chromium) under a signed token. If publishing fails after issue, the tool says so and returns the capitalCallId; approving again retries | - | - |
| Delete a wrongly-entered commitment event (both legs of a transfer) | `/api/accounting/commitments (DELETE)` | covered | lp_delete_commitment | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve | - | - |
| Delete an LP entity | `/api/lps/entities (DELETE)` | covered | lp_delete_entity | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve | - | - |
| Delete an investor | `/api/lps/investors (DELETE)` | covered | lp_delete_investor | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve | - | - |
| Email an LP portal item (snapshot/letter/document) to selected LPs | `/api/lps/send (GET recipients, POST send)` | covered | lp_send_item_recipients; lp_send_item (admin-only, preview first) | Closed in feat/lp-portal-tools. Covers links and every attachment: a snapshot attaches each recipient's own statement PDF and a letter its PDF, downloaded from `/api/agent/reports/<token>` (which ships Chromium). A recipient whose PDF cannot be rendered is not emailed | - | - |
| Invite an LP to the portal / disable or re-enable / unlink / resend invite / bulk invite | `/api/lps/invites (POST/PATCH/DELETE); /invites/resend (POST); /invites/bulk (POST)` | covered | lp_portal_invite; lp_portal_account_status; lp_portal_unlink; lp_portal_resend_invite; lp_portal_invite_bulk (all admin-only; bulk also invites every LP missing an account) | Closed in feat/lp-portal-tools | - | - |
| Merge one investor into another | `/api/lps/investors (PATCH)` | covered | lp_merge_investors | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve | - | - |
| Send an announcement email to chosen LPs (preview + send) | `/api/lps/announce (POST)` | covered | lp_announce (admin-only, preview first) | Closed in feat/lp-portal-tools | - | - |
| Sort a batch of uploaded onboarding docs and confirm filing | `/api/lps/onboarding/sort (POST); /sort/confirm (POST)` | gap | - | deliberate: browser-only file upload batch (signed upload to lp-documents) | Possible with an LP-doc upload-url tool; low priority | L |
| View/grant/revoke LP authorized users (advisors) | `/api/lps/authorized-users (GET/POST/DELETE)` | covered | lp_authorized_users; lp_authorized_user_add; lp_authorized_user_remove (admin-only) | Closed in feat/lp-portal-tools | - | - |

### Portfolio: companies, updates, metrics, emails, compliance

| Action | Route | Status | Nearest tool | Reason | Fix | Effort |
|---|---|---|---|---|---|---|
| Accept an inbound email into a diligence data room | `emails/[id]/accept-to-diligence (POST)` | partial | diligence_add_documents | diligence_add_documents takes uploaded files, not an inbound email/attachments by index; route is deliberately the human gate for evidence | diligence_accept_email tool (staged) reusing route logic | M |
| Add a KPI metric to a company (name, unit, type, cadence, currency) | `companies/[id]/metrics (POST)` | gap | - | no reason found - likely oversight; record_metric_value fails with 'no metric' when it is missing | create_metric tool doing the same insert into metrics | S |
| Add a fund default metric (optionally apply to all companies) | `default-metrics (POST)` | gap | - | settings-level; no reason found | create_default_metric tool | S |
| Add a fund-of-funds holding with terms | `portfolio/fund-holdings (POST)` | gap | - | no reason found | add holding_type=fund + terms to create_company or add_fund_holding tool | M |
| Add a portfolio company (holding type company/fund/crypto, choose default metrics, custom metrics, notes) | `companies (POST)` | partial | create_company | create_company calls same lib/companies/create.createCompany but schema lacks holding_type (fund/crypto), default_metric_ids subset, custom_metrics, notes/current_update; no reason found - likely oversight | Add holding_type, default_metric_ids, custom_metrics, notes to create_company schema and pass through | S |
| Add or verify a crypto wallet address | `companies/[id]/wallets (POST)` | gap | - | no reason found - niche feature | add_wallet tool; move POST body into lib/portfolio/wallets | M |
| Answer the compliance profile questionnaire (registration, AUM, structure, Reg D...) | `compliance/profile (POST)` | gap | - | no reason found | set_compliance_profile tool | S |
| Apply default metrics to every company | `default-metrics/apply (POST)` | gap | - | no reason found | easy-win: tool calling lib/metrics/seed-default-metrics.applyDefaultsToAllCompanies | S |
| Approve all / reject all reviews for an email | `emails/[id]/reviews (POST)` | gap | - | no reason found | bulk mode on resolve_review | S |
| Assign an email to a company / set processing status | `emails/[id] (PATCH)` | partial | inbox_done | inbox_done only for waiting emails and forces routed_to=reporting | email_assign_company tool reusing PATCH logic | S |
| Browse inbound emails (all routes, statuses) | `emails (GET)` | partial | inbox_waiting (keyless waiting only), get_updates | only emails waiting for a keyless fund, or captured updates; no general inbox listing; no reason found | list_inbound_emails tool | S |
| Bulk import documents and AI-match them to companies | `import/documents (POST)` | partial | submit_company_update; company_document_upload_url + add_company_document | One company per call: submit_company_update takes 5 files (uploaded with company_update_upload_url, up to 25 MB each), and company documents are added one at a time; no bulk AI matching of many files to companies | - | - |
| Clear stored summaries | `companies/[id]/summary (DELETE)` | gap | - | UI-only housekeeping | low priority | S |
| Configure a price feed / record a quote / book the quoted mark | `companies/[id]/price-feed (POST action=set\|record-quote\|book)` | partial | record_investment(valuation_change_source=quote) | record_investment can book a hand-computed quote mark, but feed config, quote recording and bookQuoteMark (Level 1/2 valuation evidence read by close checks) are not exposed; no reason found | book_quote_mark tool wrapping lib/portfolio/quote-marks.bookQuoteMark (easy-win); set_price_feed later | S |
| Confirm (book) an underlying-fund capital event | `portfolio/fund-holdings/[id]/events (PATCH)` | gap | - | no reason found | easy-win: tool calling lib/portfolio/fof-register.confirmFundCapitalEvent | S |
| Delete a NAV statement | `portfolio/fund-holdings/[id]/nav (DELETE)` | gap | - | no reason found | deleteNavStatement | S |
| Delete a company document | `companies/[id]/documents/[docId] (DELETE)` | gap | - | no reason found | delete_company_document tool | S |
| Delete a company note | `companies/[id]/notes/[noteId] (DELETE)` | gap | - | no reason found | delete_note tool | S |
| Delete a fund default metric | `default-metrics/[id] (DELETE)` | gap | - | settings-level; no reason found | delete_default_metric tool | S |
| Delete a fund holding (and its ledger accounts) | `portfolio/fund-holdings/[id] (DELETE)` | gap | - | dangerous (deletes chart accounts); would belong with delete_company | cover via staged delete_company | M |
| Delete a governing document | `entities/[id]/documents/[docId] (DELETE)` | gap | - | no reason found | delete_entity_document tool (staged) | S |
| Delete a metric and its values (force) | `metrics/[id] (DELETE)` | gap | - | destructive, but member-level in app; no reason found | delete_metric tool (staged) | S |
| Delete a note | `dashboard/notes/[noteId] (DELETE)` | gap | - | no reason found | delete_note tool | S |
| Delete an email attachment | `emails/[id]/attachment/[index] (DELETE)` | gap | - | no reason found - low value | - | S |
| Delete one data point | `metric-values/[id] (DELETE)` | gap | - | no reason found - likely oversight | delete_metric_value tool (easy-win: scoped delete on metric_values) | S |
| Dismiss a proposed diligence intake | `emails/[id]/accept-to-diligence (DELETE)` | gap | - | no reason found | flag on diligence_accept_email | S |
| Download a company document | `companies/[id]/documents/[docId] (GET)` | gap | - | no reason found | signed-link tool like report-links | S |
| Download a governing document | `entities/[id]/documents/[docId]/download (GET)` | gap | - | no reason found; text is searchable but no file link | signed link | S |
| Download an email attachment | `emails/[id]/attachment/[index] (GET)` | partial | inbox_read (text only) | text only; no original file | signed link | S |
| Edit a NAV statement / rebook later NAVs | `portfolio/fund-holdings/[id]/nav (PATCH)` | gap | - | no reason found | editNavStatement/rebookNavsFrom via same tool | S |
| Edit a company: name, aliases, tags, stage, industry, country, status (active/exited/written-off), overview, founders, why invested, contact emails, entities, Google Drive folder | `companies/[id] (PATCH)` | gap | - | no reason found - likely oversight (no update_company tool; contact emails/aliases govern inbound-email matching) | update_company tool; extract PATCH body handling into lib/companies/update.ts shared by route and tool (mergeGroupsForWrite, ensureVehiclesByName) | M |
| Edit a fund default metric | `default-metrics/[id] (PATCH)` | gap | - | settings-level; no reason found | update_default_metric tool | S |
| Edit a fund holding's terms (commitment, fees, etc.) | `portfolio/fund-holdings/[id] (PATCH)` | gap | - | no reason found | update_fund_holding tool | S |
| Edit a governing document's kind, title, effective date | `entities/[id]/documents/[docId] (PATCH)` | gap | - | no reason found | easy-win: update_entity_document (same update on entity_documents) | S |
| Edit a metric definition (rename, unit, cadence, active, order, currency) | `metrics/[id] (PATCH)` | gap | - | no reason found - likely oversight | update_metric tool | S |
| Edit a portfolio transaction | `companies/[id]/investments/[txnId] (PATCH)` | partial | update_investment | same lib updateInvestmentTransaction, but manifest schema exposes a subset of EDITABLE_TXN_FIELDS (no split/income/escrow_receipt types, security_type, postmoney, ownership...) | Generate schema from EDITABLE_TXN_FIELDS | S |
| Edit one data point (value, period, notes) | `metric-values/[id] (PATCH)` | partial | record_metric_value | record_metric_value overwrites value for a metric+period, but cannot move a value to another period or edit by id | accept value_id/new period on record_metric_value or add update_metric_value | S |
| Edit own company note | `companies/[id]/notes/[noteId] (PATCH)` | gap | - | no reason found | update_note tool (author-only check as route) | S |
| Edit, pin or move a note to another entity | `dashboard/notes/[noteId] (PATCH)` | gap | - | no reason found | update_note tool | S |
| Enter a manager NAV statement (books the mark) | `portfolio/fund-holdings/[id]/nav (POST)` | partial | record_investment(valuation_change_source=nav) | agent can book a hand-computed NAV mark but not store the NAV statement that drives rebooking | easy-win: record_nav_statement calling lib/portfolio/fof-nav.saveNavStatement | S |
| Import investment transactions in bulk | `import/investments (POST)` | partial | record_investment, stage_run | same: per-row tool calls; record_investment schema gaps apply | - | - |
| List / add known referrers (deal-flow intro sources) | `known-referrers (GET, POST)` | gap | - | no reason found (deals-area setting) | known_referrers tool | S |
| List a company's documents (uploads + email history) | `companies/[id]/documents (GET)` | partial | get_updates (email-borne only) | uploaded company documents not listed; no reason found | list_company_documents tool | S |
| List fund-of-funds holdings (LP interests in other funds) | `portfolio/fund-holdings (GET)` | partial | portfolio_summary, list_companies | positions appear in summaries but commitment/unfunded/terms are not exposed | fund_holdings read tool over lib/portfolio/fof-holdings.fundHoldingRows | S |
| Manage compliance resource links | `compliance/links (GET, POST, PATCH, DELETE)` | gap | - | low value reference links | - | S |
| Mark a company's response (yes/no/na/waived) | `requests/responses (PATCH)` | gap | - | no reason found | easy-win: data_request_mark tool doing the same upsert via lib/requests/response-status | S |
| Mark a filing filed / not applicable / dismissed for a year, with note and link | `compliance/settings (PATCH)` | gap | - | no reason found - likely oversight; compliance_calendar reports state but cannot change it | easy-win: mark_compliance_item tool reproducing the PATCH upsert | S |
| Open an inbound email with extracted metrics and reviews | `emails/[id] (GET)` | partial | inbox_read (waiting only) | inbox_read refuses emails not in waiting state | generalise inbox_read | S |
| Opt a company out of / back into one fund default metric | `companies/[id]/default-metrics/[defaultId] (PATCH)` | gap | - | no reason found - low value | flag on seed_default_metrics | S |
| Post a general team note (optional @company, entity) | `dashboard/notes (POST)` | partial | add_company_note | add_company_note requires a company; general notes impossible | make company optional on add_company_note | S |
| Read a company's internal notes | `companies/[id]/notes (GET)` | gap | - | no reason found - no tool reads company_notes at all | list_notes tool over the same scopeNotesQuery | S |
| Read a company's stored AI summary | `companies/[id]/summary (GET)` | gap | - | company_detail does not return company_summaries; likely oversight | add latest summary to company_detail | S |
| Read general (non-company) team notes | `dashboard/notes (GET)` | gap | - | no reason found | list_notes tool | S |
| Read the notes feed across companies (filters, unread) | `notes (GET)` | gap | - | no reason found | list_notes tool (same as company notes) | S |
| Record a portfolio transaction (investment, proceeds, escrow receipt, mark, round info, split, income) with security type, SAFE conversion link, post-money, ownership, fees, currency originals | `companies/[id]/investments (POST)` | partial | record_investment | record_investment enum lacks escrow_receipt/split/income; schema lacks security_type, converts_from_txn_id (handler supports it), postmoney/ownership/exit valuation, fee_amount, interest_converted, proceeds_written_off/per_share, income_*; also a separate insert path (executeRecordInvestment) that can drift from the route; no reason found | Widen schema to TRANSACTION_TYPES and all route fields; make route and tool share one lib function | M |
| Record an underlying-fund capital call or distribution | `portfolio/fund-holdings/[id]/events (POST)` | gap | - | no reason found - likely oversight (common FoF bookkeeping) | record_fund_capital_event tool | M |
| Remove a crypto wallet | `companies/[id]/wallets (DELETE)` | gap | - | no reason found - niche feature | remove_wallet tool | S |
| Remove a known referrer | `known-referrers/[id] (DELETE)` | gap | - | no reason found | same tool | S |
| Rename a vehicle, change kind, deactivate, set aliases | `vehicles (PATCH)` | gap | - | no reason found (structure change; would be admin-staged) | update_vehicle tool | M |
| Reprocess an email through the AI pipeline | `emails/[id]/reprocess (POST)` | gap | - | no reason found (needs server AI key; keyless funds use inbox_* instead) | reprocess_email tool calling lib/pipeline/processEmail.runPipeline | S |
| Reroute an email (reporting / interactions / deals / audit) | `emails/[id]/reroute (POST)` | gap | - | no reason found - misrouted mail (e.g. a receipt) cannot be fixed headlessly | reroute_email tool; extract route body to lib/pipeline/reroute.ts | M |
| Resolve a review item (accept, reject, correct; approve FoF capital/NAV review) | `review/[id]/resolve (POST)` | gap | - | no reason found - headless loop is broken: items queued by submit_company_update can only be cleared in the browser | resolve_review tool; move route body into lib (approveFundReview already in lib) | M |
| Save a data request draft (subject, body, recipients, quarter) | `requests (POST)` | gap | - | no reason found | data_request_save tool | S |
| See which fund default metrics a company tracks / opted out of | `companies/[id]/default-metrics (GET)` | gap | - | no reason found | include in company_metrics output | S |
| Seed missing fund default metrics onto a company | `companies/[id]/default-metrics (POST)` | partial | create_company (seeds on create only) | only at creation; no reason found | easy-win: seed_default_metrics tool calling lib/metrics/seed-default-metrics.seedCompanyFromDefaults | S |
| Send the quarterly data request email to portfolio companies | `requests/send (POST)` | gap | - | plausibly deliberate (outbound email to external parties) but other outbound sends are staged for approval elsewhere; no stated reason | data_request_send tool, staged | M |
| Set a vehicle's letterhead (logo, name, address, email) | `vehicles (PATCH logo/letterhead*)` | gap | - | logo is an image upload; text fields no reason found | add letterhead text fields to set_entity_profile | S |
| Set which filings apply (bulk) | `compliance/settings (POST)` | gap | - | no reason found | set_compliance_items tool | S |
| Stop pricing a holding from a feed | `companies/[id]/price-feed (DELETE)` | gap | - | no reason found | include as action on a set_price_feed tool | S |
| View NAV statements for a fund holding | `portfolio/fund-holdings/[id]/nav (GET)` | gap | - | no reason found | include in fund_holdings tool | S |
| View a company's recent interactions | `companies/[id]/interactions (GET)` | gap | - | no reason found - no interactions tool exists | list_interactions read tool | S |
| View a digital-asset holding's wallets and balance variance | `companies/[id]/wallets (GET)` | gap | - | no reason found - niche digital-asset feature not prioritised | list_wallets read tool over walletsForEntity/walletVariances | S |
| View a fund holding's detail, terms and pending reviews | `portfolio/fund-holdings/[id] (GET)` | partial | company_detail | terms/commitment/review items missing | extend company_detail for fund holdings | S |
| View a holding's price feed, stored quotes and the quoted mark each entity owes | `companies/[id]/price-feed (GET)` | gap | - | no reason found - likely oversight | price_feed read tool over quoteMarkForHolding | S |
| View fund default metric profile | `default-metrics (GET)` | gap | - | no reason found | list_default_metrics tool | S |
| View pending reviews for one email | `emails/[id]/reviews (GET)` | gap | - | no reason found | part of list_reviews(email) | S |
| View the data request draft and send history | `requests (GET)` | partial | data_request_status | status only; not the template/recipients | - | S |
| View the interactions log (emails routed to interactions) | `interactions (GET)` | gap | - | no reason found | list_interactions tool | S |
| View the review queue (uncertain extracted KPIs, unmatched companies, FoF items) | `review (GET)` | gap | - | no reason found - likely oversight; submit_company_update sends items here but no tool reads them | list_reviews tool | S |
| View underlying-fund capital calls/distributions | `portfolio/fund-holdings/[id]/events (GET)` | gap | - | no reason found | include in fund_holdings tool | S |
| View vehicle groups | `vehicle-groups (GET)` | gap | - | read-only, minor | add groups to list_vehicles | S |
| View vehicles with letterhead and reporting profile | `vehicles (GET)` | partial | list_vehicles, entity_profile | letterhead not readable | - | S |
| View/download an update attachment (original file) | `company-updates/[id]/artifacts/[artifactId] (GET)` | partial | get_updates(artifact) | agent gets extracted text only, never the original file/download link | add a short-lived signed download URL (report-links pattern) | S |
| AI import of portfolio (companies + investments) from pasted spreadsheet text | `import (POST)` | partial | portfolio_import_preview; create_company, record_metric_value, record_investment, stage_run | feat/agent-uploads: with a server key, portfolio_import_preview runs the route's parse (lib/portfolio/ai-import.ts) and returns the proposal, writing nothing; without one the agent parses the rows itself. Applying it is partial: no tool creates a new metric or updates an existing company's fields, which the web import does | metric create and company edit tools (see 'Company and metric upkeep') | M |
| Attach a document to an inbound email | `emails/[id]/attachments (POST)` | covered | email_attachment_upload_url; add_email_attachment | Closed in feat/agent-uploads: signed URL in the email's folder, then lib/emails/attachments.ts registerEmailAttachment (verify size, scan, list), the route's own function. Also by inbound deal (its source email) | - | - |
| Delete a company (admin-only) | `companies/[id] (DELETE)` | covered | delete_company | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve | - | - |
| Generate an AI summary server-side | `companies/[id]/summary (POST)` | covered | company_generate_summary; company_save_summary | Closed in feat/agent-uploads: company_generate_summary calls lib/companies/summary.ts generateCompanySummary, the Summarise button's function; with no server key it refuses and points to company_save_summary | - | - |
| Merge one vehicle into another | `vehicles (PATCH mergeIntoId)` | covered | merge_vehicles | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve; the route is now in ADMIN_ONLY_ROUTES too | - | - |
| Save email attachments to Google Drive | `emails/save-to-drive (POST)` | gap | - | deliberate-ish: depends on fund's Google OAuth credential; low value for an agent with its own Drive connector | - | M |
| Upload a document to a company (text extracted, virus-scanned) | `companies/[id]/documents (POST)` | covered | company_document_upload_url; add_company_document | Closed in feat/agent-uploads: signed URL in the company's folder, then lib/companies/documents.ts registerCompanyDocument (scan, extract, record), the route's own function | - | - |

### Deal flow and diligence

| Action | Route | Status | Nearest tool | Reason | Fix | Effort |
|---|---|---|---|---|---|---|
| Analyze data room (ingest documents into evidence) | `/api/diligence/[id]/agent/ingest (POST)` | partial | diligence_run_agent (stage analyze, full) | Tool cannot target a subset of documents (route accepts document_ids) | Pass input.document_ids through enqueueMemoStage opts to enqueueAnalysis(..., {documentIds}) | S easy-win |
| Answer Q&A interview questions | `/api/diligence/[id]/agent/qa/respond (POST)` | gap | - | no reason found | diligence_qa_respond wrapping recordResponses() | S easy-win |
| Delete a data-room document | `/api/diligence/[id]/documents/[docId] (DELETE)` | gap | - | no reason found (destructive; could be staged) | diligence_delete_document (row + storage remove) | S easy-win |
| Delete a deal note (author or admin) | `/api/diligence/[id]/notes/[noteId] (DELETE)` | gap | - | no reason found | diligence_delete_note with author/admin check | S easy-win |
| Delete checklist item | `/api/diligence/[id]/checklist (DELETE)` | gap | - | no reason found - likely oversight | diligence_delete_checklist_item (single scoped delete) | S easy-win |
| Edit checklist item (status, label, notes, facts) | `/api/diligence/[id]/checklist (PATCH)` | partial | diligence_update_checklist_item | Tool cannot edit agent_notes or edit/remove partner_facts (add_fact only appends) | Expose partner_facts array replace + agent_notes via updateChecklistItem | S easy-win |
| Edit diligence deal (name, sector, stage, lead, status, entity) | `/api/diligence/[id] (PATCH)` | partial | diligence_update_deal | Tool lacks current_memo_stage override (route accepts it); otherwise same lib fn updateDiligenceDeal | Add memo_stage input passing memoStage to updateDiligenceDeal | S easy-win |
| Export memo (Markdown / Word .docx / Google Doc) | `/api/diligence/[id]/agent/render (POST)` | gap | diligence_memo (prose only) | no reason found - diligence_memo returns prose but no docx/gdoc export | diligence_export_memo(deal, format) calling runRenderJob(admin,{fundId,dealId,draftId,payload:{format}}) from lib/memo-agent/jobs/render-job.ts; return content or link | S easy-win |
| Finish Q&A interview (write answers into draft) | `/api/diligence/[id]/agent/qa/finish (POST)` | gap | - | no reason found | diligence_qa_finish wrapping finishQA() | S easy-win |
| List deal notes | `/api/diligence/[id]/notes (GET)` | partial | diligence_deal_detail (notes_summary only) | No tool returns the individual notes | diligence_notes read tool | S easy-win |
| Reclassify a document / set parse status or notes | `/api/diligence/[id]/documents/[docId] (PATCH)` | gap | - | no reason found | diligence_update_document(detected_type, parse_status, parse_notes) | S easy-win |
| Start partner Q&A interview / get next question batch | `/api/diligence/[id]/agent/qa/next-batch (POST)` | gap | - | no reason found - interactive partner interview not exposed; agent could relay questions to the partner | diligence_qa_next tool wrapping startQASession() + getNextBatch() + loadSessionState() in lib/memo-agent/stages/qa.ts | M easy-win |
| View / save fund-wide default checklist template | `/api/diligence/checklist-template (GET, PATCH)` | gap | - | no reason found; settings-type write (not admin-gated in web) | diligence_checklist_template get/save on fund_settings.diligence_checklist_template | S easy-win |
| View emails waiting to join a deal's data room | `/api/diligence/[id]/email-intake (GET)` | gap | - | no reason found (accept/reroute live under /api/emails - other area) | diligence_email_intake list tool (read inbound_emails routed to deal) | S easy-win |
| View fund-wide diligence inbox (open attention items across deals) | `/api/diligence/inbox (GET)` | partial | query_diligence (deals only) | No cross-deal attention list; agent must loop diligence_memo per deal | diligence_attention_inbox(status, urgency) querying diligence_attention_items scoped by visibleVehicleIds (mirror route) | S easy-win |
| View memo draft history / a specific draft | `/api/diligence/[id]/drafts (GET); /api/diligence/[id]/drafts/[draftId] (GET)` | partial | diligence_memo | Tool reads only the latest draft; no history or finalized versions | Add optional draft_id/list to diligence_memo | S easy-win |
| Add a partner-authored Q&A entry (question + own answer) | `/api/diligence/[id]/agent/qa/add-question (POST)` | gap | - | no reason found (partial workaround: diligence_add_note / diligence_update_checklist_item add_fact); logic inline in route | diligence_add_qa_entry appending to latest draft qa_answers | S |
| Add empty checklist section | `/api/diligence/[id]/checklist (POST mode=add_section)` | partial | diligence_add_checklist_item | Section is created only implicitly with an item | Allow label-less section creation, or accept as-is | S |
| Ask the data room a question (Q&A chat) | `/api/diligence/[id]/qa-chat (POST)` | partial | diligence_ask | Same lib fn answerDealQuestion, but tool does not persist chat history nor auto-feed the exchange into draft qa_answers evidence | Optional persist flag reusing route's insert + evidence feed | S |
| Browse linked Google Drive folder files | `/api/diligence/[id]/documents/drive-files (GET)` | gap | - | no reason found; uses fund Google OAuth | diligence_drive_files listing via listFilesRecursive | S |
| Delete a Q&A entry | `/api/diligence/[id]/agent/qa/entry (DELETE)` | gap | - | no reason found; inline route logic | Same tool with delete flag | S |
| Edit / delete a memo preset | `/api/diligence/memo-presets/[presetId] (PATCH, DELETE)` | gap | - | no reason found | Same tool with update/delete | S |
| Edit research findings / gap analysis / cross-doc flags | `/api/diligence/[id]/drafts/[draftId] (PATCH research_output, ingestion_gap_analysis, ingestion_cross_doc_flags)` | gap | - | no reason found | diligence_edit_evidence tool mirroring route patch logic (extract to lib) | M |
| Exclude/include a Q&A entry from evaluation | `/api/diligence/[id]/agent/qa/entry (PATCH)` | gap | - | no reason found; inline route logic | diligence_update_qa_entry (excluded flag) | S |
| Import Affinity notes/files into the data room | `/api/diligence/[id]/documents/from-affinity (POST, streaming)` | gap | - | no reason found; route streams progress events (long-running) | Tool calling importAffinityIntoDataRoom() then enqueueIngestForDocuments(), return summary (or run as a job) | M |
| Import files from Google Drive into data room | `/api/diligence/[id]/documents/from-drive (POST, streaming)` | gap | - | no reason found; long-running streamed import, logic inline in route | Extract importFromDrive() into lib/google or lib/diligence; run as background job tool | M |
| Link a deal to an Affinity organization/opportunity | `/api/diligence/[id]/affinity (POST)` | gap | - | no reason found - likely oversight | diligence_affinity_link (organization_id, opportunity_id) writing affinity_* columns on diligence_deals | S |
| Override rubric scores | `/api/diligence/[id]/drafts/[draftId] (PATCH score_edits)` | gap | - | no reason found - partner judgement edit not exposed | diligence_edit_score(dimension, score, rationale) | S |
| Preview screening prompt/thesis on a sample pitch (admin) | `/api/deals/preview (POST)` | gap | - | UI-only settings preview helper; low value headless (agent can just reason over prompt) | Optional deals_preview_screening wrapping analyzeDeal() from lib/claude/analyzeDeal with getFeatureProvider(...,'deal_analysis') | S |
| Re-run AI screening on an inbound deal (regenerate thesis-fit analysis) | `/api/deals/[id]/regenerate (POST)` | gap | - | no reason found - likely oversight (workaround: deals_update_inbound lets the agent write analysis itself; logic lives inline in the route, not in lib) | Move route body into lib/deals/service.ts regenerateDealAnalysis() (extractAttachmentText + analyzeDeal + update) and add deals_regenerate_analysis tool | M |
| Re-run checklist assessment only (after editing checklist) | `/api/diligence/[id]/agent/checklist-assessment (POST)` | partial | diligence_run_agent (stage analyze) | analyze triggers assessment but also re-ingests; no checklist-only stage; logic inline in route (job insert + kickWorker) | Add stage 'checklist' to diligence_run_agent; move job enqueue into lib/memo-agent/enqueue.ts | S |
| Reorder checklist items | `/api/diligence/[id]/checklist (POST mode=reorder)` | gap | - | UI-only cosmetic | None needed | - |
| Reorder or hide memo paragraphs | `/api/diligence/[id]/drafts/[draftId] (PATCH paragraph_order, paragraph_visibility)` | gap | - | no reason found (mostly editorial) | Extend diligence_write_memo with order/hidden ops | S |
| Replace whole checklist from pasted text / apply fund template | `/api/diligence/[id]/checklist (POST mode=replace)` | gap | - | no reason found; logic inline in route (parseChecklistText + wipe + insert) | Extract to lib/diligence/service.ts replaceChecklist(); tool diligence_replace_checklist(deal, text) | M |
| Search Affinity orgs / view Affinity link status for a deal | `/api/diligence/[id]/affinity (GET)` | gap | - | no reason found - uses the caller's personal Affinity API key (getAffinityKey), which the headless context also has via userId | diligence_affinity_search tool wrapping AffinityClient search | M |
| Transcribe an uploaded call recording | `/api/diligence/[id]/agent/transcribe (POST)` | gap | - | no reason found - likely oversight (recording upload itself is browser-only due to size, but transcribing an already-uploaded one is not) | diligence_transcribe(deal, document) inserting the transcribe memo_agent_jobs row + kickWorker (extract to lib first) | S |
| Unlink a deal from Affinity | `/api/diligence/[id]/affinity (DELETE)` | gap | - | no reason found - likely oversight | Same tool with unlink flag | S |
| View / clear Q&A chat history | `/api/diligence/[id]/qa-chat (GET, DELETE)` | gap | - | UI-only chat history (low value headless) | None needed unless persistence added | - |
| View / create memo presets (per-stage templates) | `/api/diligence/memo-presets (GET, POST)` | gap | - | no reason found | diligence_memo_presets list/save | S |
| View / edit per-deal memo config (guidance, style, persona, complexity) | `/api/diligence/[id]/memo-config (GET, PATCH)` | gap | - | no reason found | diligence_memo_config get/set (validate like route) | S |
| View / edit per-stage memo-agent prompt guidance | `/api/diligence/prompts (GET, PATCH)` | gap | - | no reason found (could be deliberate: steers AI prompts, but web lets any member edit) | diligence_stage_guidance get/set (upsert memo_agent_prompts) | S |
| View diligence analytics (admin: pipeline by partner, cycle times) | `/api/diligence/analytics (GET)` | partial | query_diligence (raw rows only) | No aggregate analytics tool; agent can compute from query_diligence rows | diligence_analytics read tool (admin) reusing route aggregation moved to lib | S |
| View per-deal AI usage and cost | `/api/diligence/[id]/usage (GET)` | gap | - | no reason found | diligence_usage read tool (move pricing calc to lib) | S |
| Add an inbound deal by hand (with deck files) | `/api/deals/manual (POST)` | covered | deals_deck_upload_url; deals_create_inbound (uploaded_files) | Closed in feat/agent-uploads: decks up to 10 MB each are PUT to a fund staging folder and read back into createManualDeal, as the form's files are | - | - |
| Delete a diligence deal (admin; cascades docs, drafts, notes) | `/api/diligence/[id] (DELETE)` | covered | diligence_delete_deal | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve; the route is now in ADMIN_ONLY_ROUTES too | - | - |
| Upload documents to data room (multipart, or signed URL then record) | `/api/diligence/[id]/documents (POST); /api/diligence/[id]/documents/upload-url (POST)` | covered | diligence_document_upload_url; diligence_add_documents (uploaded_files) | Closed in feat/agent-uploads: createDiligenceUploadUrl and registerUploadedDiligenceDocument, the routes' own functions (existence and size check, scan, classify, record, queue transcription), up to 100 MB | - | - |

### Settings, team, approvals, AI usage

| Action | Route | Status | Nearest tool | Reason | Fix | Effort |
|---|---|---|---|---|---|---|
| Approve/reject a join request (with entity choice) | `/api/settings/members/[id] (PATCH action=approve\|reject)` | gap | - | no reason found - likely oversight; admin-only | Admin tool members_decide_join_request (parseApprovalEntities) | S easy-win |
| Change my display name | `/api/settings (PATCH displayName)` | gap | - | no reason found - likely oversight (any member may do it) | Tool set_my_display_name updating fund_members.display_name for ctx.userId | S easy-win |
| Configure deal web research (enabled, min fit) | `/api/settings/deal-research (GET/PUT)` | gap | deals_research_inbound (per-deal run only) | no reason found (cost implication is the only note) | Tool deals_set_research {enabled, minFit} admin | S easy-win |
| Configure ops reminder digest (enabled, recipients, offsets) | `/api/settings/reminders (GET/PATCH)` | gap | whats_due (reads what is due only) | no reason found | Admin tool set_reminders using loadReminderSettings/parseRecipients/scopedRecipients | S easy-win |
| Deal intake settings: thesis, screening prompt, intake enabled, default vehicle | `/api/settings (PATCH dealThesis, dealScreeningPrompt, dealIntakeEnabled, dealsDefaultVehicleId)` | gap | - | no reason found - likely oversight (deals_* tools exist but not their config) | Tool deals_set_screening {thesis, prompt, intakeEnabled, defaultVehicleId} | S easy-win |
| Edit AI summary prompt (company update summaries) | `/api/settings (PATCH aiSummaryPrompt)` | gap | - | no reason found - likely oversight | Tool set_ai_summary_prompt (admin) | S easy-win |
| Edit outbound email sender name/address, approval email subject/body, asks email provider | `/api/settings (PATCH systemEmailFromName, systemEmailFromAddress, approvalEmailSubject, approvalEmailBody, asksEmailProvider)` | gap | - | no reason found - non-secret text settings | Tool set_email_templates (admin) wrapping the same PATCH fields | S easy-win |
| Remove an authorized sender | `/api/settings/senders/[id] (DELETE)` | gap | - | no reason found - setup_fund is additive only | Add removeSenders to setup_fund or tool remove_sender | S easy-win |
| Set AI mode (own assistant vs server key) | `/api/settings (PATCH aiMode)` | partial | setup_fund(aiMode) | setup_fund only accepts aiMode='assistant'; cannot set back to server mode (adding a key does that, which is web-only) | Accept full enum in setup_fund.aiMode | S easy-win |
| Set fund address and letterhead contact email | `/api/settings (PATCH fundAddress, fundContactEmail)` | partial | set_entity_profile (per-vehicle letterhead only) | no reason found - fund-level letterhead fields not exposed; vehicle-level override is | Extend setup_fund or add set_fund_profile {address, contactEmail} with same email validation | S easy-win |
| Set my email notification preferences (level, subscribed companies) | `/api/settings/notifications (GET/PATCH)` | gap | - | no reason found - per-user preference | Tool set_my_notifications {level, subscribedCompanyIds} | S easy-win |
| Set or clear a member's access end date | `/api/settings/access (PATCH {userId, accessExpiresAt})` | partial | setup_fund(team.accessEndsOn) | can set a date but cannot clear to no end date (null); also members-only | Allow accessEndsOn: null in setup_fund | S easy-win |
| View AI usage and cost (monthly, daily, by source) | `/api/usage (GET)` | gap | - | no reason found - read-only report | Read tool ai_usage reusing route aggregation (move to lib) | S easy-win |
| View access grid (members x domains grants, fund defaults) | `/api/settings/access (GET)` | partial | setup_status (team counts + presets only) | setup_status gives counts, not per-member grants | Read tool team_access returning same shape as GET (admin) | S easy-win |
| View fund settings (all config fields, which secrets are set) | `/api/settings (GET)` | partial | setup_status | setup_status returns products, agentAccess, ai mode, team counts, entities, checklist; not providers/models/email/storage/deal/currency/lot method/feature levels | Add read tool fund_settings_get returning the same non-secret allowlist as GET /api/settings (has* booleans for secrets) | S easy-win |
| View schema history / roll back a schema | `/api/firm/schemas/[name]/history (GET), /rollback (POST)` | gap | - | no reason found | Tool wrapping getSchemaHistory/rollbackSchema | S easy-win |
| Choose default AI provider, models, OpenRouter base URL | `/api/settings (PATCH defaultAIProvider, claudeModel, openaiModel, openrouterModel, openrouterBaseUrl)` | gap | - | no reason found - non-secret config (base URL is SSRF-validated via validateBaseUrlResolved) | Tool set_ai_preferences reusing PATCH validation; list models via claude-models/openai-models helpers | S |
| Customize sign-in screen (logo, title) | `/api/settings (PATCH signInLogo, signInTitle)` | gap | - | UI-only cosmetic (branding of login page; image payload) | None needed | - |
| Disable user activity tracking | `/api/settings (PATCH disableUserTracking)` | gap | - | UI-only privacy preference for web activity logging | None needed | - |
| Edit fund theme/appearance | `/api/settings/theme (GET/PATCH)` | gap | - | UI-only cosmetic | None needed | - |
| List/view/edit/delete style anchors | `/api/firm/style-anchors (GET), /[id] (GET/PATCH/DELETE)` | gap | - | no reason found | Tools style_anchors list/update/delete | S |
| Manage entity groups (create, rename, reorder, delete, assign entity to group) | `/api/settings/vehicle-groups (GET/POST/PATCH/DELETE)` | gap | list_vehicles (no group info?) | no reason found - likely oversight; groups drive list grouping | Admin tool vehicle_groups {op} using loadGroups and same updates | S-M |
| Manage signup allow-list (email patterns) | `/api/settings/whitelist (GET/POST), /api/settings/whitelist/[id] (DELETE)` | partial | setup_fund(team) inserts exact emails | no patterns (e.g. *@firm.com), no list, no removal; signup gate is security-sensitive | Admin-only tool if needed; else keep web-only | S |
| Restrict/expand which entities a member sees | `/api/settings/access (PATCH entity grants) + team section` | partial | setup_fund(team.entities) | setup_fund only adds entity grants (upsert); cannot revoke a granted entity | Make entities a replace-set or add remove list | S |
| Retain resolved reviews / TTL days | `/api/settings (PATCH retainResolvedReviews, resolvedReviewsTtlDays)` | gap | - | no reason found - minor admin setting | Fold into a generic admin settings tool | S |
| Send test reminder digest now | `/api/settings/reminders/test (POST)` | gap | - | no reason found; low value (sends email) | Admin tool wrapping runFundReminders (rate-limited) | S |
| Set fund currency and lot method (FIFO etc.) | `/api/settings (PATCH currency, lotMethod)` | gap | - | no reason found, but changes how books/gains are reported - should be admin-only staged | Admin-only tool set_fund_accounting_basis {currency, lotMethod} (forgetFundCurrency + isLotMethod), staged for approval | S |
| Set fund default access for new members | `/api/settings/access (PATCH {domain, level})` | gap | - | no reason found | Same tool as above with no userId | S |
| Set fund default dashboard entity selection | `/api/settings/dashboard-entities (GET/PUT)` | gap | show_portfolio_dashboard (takes its own filters) | UI-only: default selection for the web dashboard picker | None needed | - |
| Set one member's grant for one area | `/api/settings/access (PATCH {userId, domain, level})` | gap | setup_fund(team.preset) only | no reason found; access-control changes via agent arguably sensitive but setup_fund already applies presets, so inconsistent | Admin-only tool set_member_access using same validation (DOMAINS, entityGrantProblem) | S |
| Test transcription (Deepgram) setup | `/api/transcription/test (GET)` | gap | - | admin connection check; low value headless | Fold into setup_status diagnostics | S |
| Turn products/features on, off, or admin-only (feature visibility levels) | `/api/settings (PATCH featureVisibility)` | partial | setup_fund(products) | setup_fund only ADDS whole products once fund is set up; cannot turn off a product or set per-feature level (setup-plan.ts warns 'Turn products off in Settings') - deliberate-ish, no explicit rationale | Admin-only staged tool set_feature_visibility {feature: level} | M |
| View infra/setup health (env vars, DB tables, auth, fund) | `/api/setup (GET)` | partial | setup_status | setup_status covers fund checklist, not env/DB health | n/a for agents mostly | - |
| View team members and pending join requests | `/api/settings/members (GET)` | partial | setup_status (counts) | no names/emails or join requests | Include in team_access read tool | S |
| View/edit memo agent model defaults and cost caps | `/api/firm/memo-agent-defaults (GET/PATCH)` | gap | - | no reason found | Tool memo_agent_defaults get/set (getCapState) | S |
| View/edit memo agent schemas (rubric, checklist etc.) | `/api/firm/schemas (GET), /api/firm/schemas/[name] (GET/PUT)` | gap | - | no reason found; YAML schema editing with validation warnings | Tools memo_schema_get/save wrapping getActiveSchema/saveSchema (acceptWarnings flag) | M |
| Choose file storage provider | `/api/settings (PATCH fileStorageProvider)` | gap | - | deliberate-ish: infra choice coupled to Drive OAuth connection, which is browser-only | Keep web-only | - |
| Configure inbound email (provider, Postmark inbound address, Mailgun inbound domain, signing key, webhook token) | `/api/settings (PATCH inboundEmailProvider, postmarkInboundAddress, mailgunInboundDomain, mailgunSigningKey)` | gap | setup_status (reports step as web-only) | deliberate: needs Postmark/Mailgun account + webhook + signing secret (setup-tools.ts WEB_ONLY inbound_email). NOTE: prerequisite for the planned emailed-receipts flow | Keep secret web-only; could expose read of inbound address so an agent can tell users where to forward receipts | S |
| Configure inbound email / Postmark during onboarding | `/api/onboarding/inbound-email (PATCH), /api/onboarding/postmark (PATCH)` | gap | - | deliberate: third-party credentials + webhook (same as settings inbound row) | Keep web-only | - |
| Configure outbound email provider and its keys (Resend key, Postmark server token, Mailgun API key) | `/api/settings (PATCH outboundEmailProvider, resendApiKey, postmarkServerToken, mailgunApiKey, mailgunSendingDomain)` | gap | - | deliberate: credentials + third-party account setup | Keep web-only | - |
| Delete all fund data | `/api/settings (DELETE confirm='DELETE ALL DATA')` | gap | - | deliberate: admin-only, irreversible, destructive | Keep web-only | - |
| Generate/revoke public deal submission link | `/api/settings/deal-submission-token (POST/DELETE)` | gap | - | deliberate-ish: mints a bearer-style public URL (shown once); reasonable to keep in browser | Optional admin tool returning URL once | S |
| Remove a team member | `/api/settings/members/[id] (DELETE)` | covered | remove_member | Closed in feat/agent-destructive-actions: behind `AGENT_DESTRUCTIVE_ACTIONS=true`, always staged for an admin to approve; the route is now in ADMIN_ONLY_ROUTES too | - | - |
| Set Google Drive OAuth client id/secret | `/api/settings (PATCH googleClientId, googleClientSecret)` | gap | - | deliberate: credential | Keep web-only | - |
| Set analytics IDs (Fathom, GA) and custom head script | `/api/settings (PATCH analyticsFathomSiteId, analyticsGaMeasurementId, analyticsCustomHeadScript)` | gap | - | deliberate: custom head script is arbitrary script injection into every page; agent must not set it. IDs are UI-only | Keep web-only | - |
| Set/replace AI provider API keys (Claude, OpenAI, OpenRouter) | `/api/settings (PATCH claudeApiKey, openaiApiKey, openrouterApiKey)` | gap | - | deliberate: credential/secret should not pass through a chat (setup-tools.ts WEB_ONLY ai_key note; setup_fund says never pass keys) | Keep web-only; bootstrap script is the headless path | - |
| Turn LP portal on/off; turn investor connector (LP MCP) on/off | `/api/settings (PATCH lpPortalEnabled, lpAgentEnabled)` | covered | lp_portal_settings (admin-only) | Closed in feat/lp-portal-tools | - | - |
| Upload a style-anchor memo | `/api/firm/style-anchors/upload-url (POST), /api/firm/style-anchors (POST)` | gap | - | deliberate-ish: file upload (signed URL) - but entity_document_upload_url shows a headless upload pattern exists | Mirror entity_document_upload_url + add_entity_document for style anchors | M |
| Upload/remove fund logo | `/api/settings (PATCH fundLogo)` | gap | - | deliberate-ish: image payload (data:image URL up to 200KB) not a natural tool arg; UI cosmetic | Optional: accept a URL/upload-url flow; low priority | M |

### Investor portal (separate portal MCP)

| Action | Route | Status | Nearest tool | Reason | Fix | Effort |
|---|---|---|---|---|---|---|
| Rename my LP entity (legal name) | `/api/portal/onboarding (PATCH)` | gap | - | no reason found | Portal MCP tool rename_entity (write scope) | S easy-win |
| List/view statements (live); legacy snapshots | `/api/portal/snapshots (GET), /[id] (GET), /[id]/pdf (GET)` | partial | PORTAL MCP: show_my_position, statement_pdf | frozen snapshots retired; legacy snapshot by id/PDF not on portal MCP | None (legacy) | - |
| View access history of a shared item | `/api/portal/access-history (GET)` | gap | - | no reason found - read-only | Portal MCP read tool | S |
| Give e-K-1 electronic delivery consent | `/api/portal/onboarding/consent (POST)` | gap | - | deliberate-ish: legal e-delivery consent should be given by the person (no explicit rationale in code) | Keep web-only | - |
| Manage authorized users (advisors) on my account | `/api/portal/authorized-users (GET/DELETE)` | gap | - | deliberate-ish: delegation/access control | Read-only portal tool at most | S |
| Upload onboarding document | `/api/portal/onboarding/upload-url (POST), /api/portal/onboarding (POST)` | gap | - | deliberate: browser-only file upload ('a file is not something to hand an assistant', lib/portal/mcp-tools.ts header) | Keep web-only | - |
| Withdraw an uploaded onboarding document | `/api/portal/onboarding (DELETE)` | gap | - | deliberate-ish: tied to uploads, which stay on web | Optional portal tool | S |

## Already covered

<details><summary>Every action a tool already covers</summary>

| Area | Action | Tool |
|---|---|---|
| acct-capital-tax | Post a standard allocation entry (mgmt fee, expense, gain, distribution, carry, close) from the journal's New entry menu, as preview/draft/posted | allocation |
| acct-capital-tax | View capital-call register and per-LP called/funded/outstanding | lp_capital_summary; lp_capital_calls; show_capital_calls; query_lps(capital_call_lines) |
| acct-capital-tax | View commitment history / commitments as of a date | lp_commitments |
| acct-capital-tax | Record a commitment change (increase, decrease, transfer) | lp_record_commitment |
| acct-capital-tax | Delete a wrongly-entered commitment event (both legs of a transfer) | lp_delete_commitment (flag; staged for an admin) |
| acct-capital-tax | Merge one investor into another | lp_merge_investors (flag; staged for an admin) |
| acct-capital-tax | Delete an investor | lp_delete_investor (flag; staged for an admin) |
| acct-capital-tax | Delete an LP entity | lp_delete_entity (flag; staged for an admin) |
| acct-core | Unpost a posted entry back to draft (reason required) | unpost_entry (flag; staged for an admin) |
| acct-core | Reverse a posted entry with a dated contra-entry (reason) | reverse_entry (flag; staged for an admin) |
| acct-core | Void a posted entry (reason) | void_entry (flag; staged for an admin) |
| acct-core | Reopen closed period(s) (reason) | reopen_period (staged for an admin from chat) |
| acct-core | LP positions: delete a dated set | delete_lp_positions (flag; staged for an admin) |
| deals-diligence | Delete a diligence deal (cascades docs, drafts, notes) | diligence_delete_deal (flag; staged for an admin) |
| portfolio | Delete a company | delete_company (flag; staged for an admin) |
| portfolio | Merge one vehicle into another | merge_vehicles (flag; staged for an admin) |
| settings-admin | Remove a team member | remove_member (flag; staged for an admin) |
| acct-capital-tax | Correct a commitment event's date/amount/memo | lp_correct_commitment |
| acct-capital-tax | View/print one partner's K-1 PDF | schedule_k_pdf |
| acct-capital-tax | View one LP's capital account statement | lp_statement |
| acct-capital-tax | Preview one LP's capital statement PDF | lp_statement_pdf |
| acct-capital-tax | Add a partner (LP or GP) with commitment and capital account | add_partner |
| acct-capital-tax | Open a DRAFT notice PDF for an issued call | preview_call_notices (draftPdf links) |
| acct-capital-tax | Download the year's tax package ZIP | tax_package_zip |
| acct-capital-tax | View LP investors with entities | lp_list_investors |
| acct-capital-tax | Create an investor | lp_create_investor |
| acct-capital-tax | Rename an investor / set parent | lp_update_investor |
| acct-capital-tax | View the LP delivery log (what was emailed to LPs) | lp_delivery_log |
| acct-capital-tax | List investor groups (share picker helper) | lp_list_investors (parent roll-up) |
| acct-capital-tax | View LP entities | lp_list_investors |
| acct-capital-tax | Create an LP entity under an investor | lp_create_entity |
| acct-capital-tax | Reassign/rename an LP entity | lp_update_entity |
| acct-capital-tax | Edit an LP entity's profile (tax/contact details) | lp_update_profile |
| acct-capital-tax | View live LP report cards (per investor) | lp_live_report; lp_report_card_pdf |
| acct-capital-tax | List vehicles for LP document scoping | list_vehicles |
| acct-capital-tax | View live LP report | lp_live_report; show_lp_dashboard |
| acct-capital-tax | List LP letters | lp_letters |
| acct-capital-tax | Create an LP letter | lp_create_letter |
| acct-capital-tax | Open one LP letter | lp_letter |
| acct-capital-tax | Share/unshare an LP letter with investors | lp_share_letter |
| acct-capital-tax | Generate a whole letter with AI | lp_draft_letter |
| acct-capital-tax | Load an example letter for a template / preview portfolio data for a period | lp_letter_data; lp_letter_brief |
| acct-capital-tax | List management companies / create one | list_vehicles; setup_fund (kind=manco) |
| acct-core | View chart of accounts (auto-seeds a missing chart) | list_accounts |
| acct-core | Add one account to the chart | add_account |
| acct-core | Post a draft entry | post_drafts (ids); post_bank_transaction |
| acct-core | Bulk-post drafts (window or ids, paged) | post_drafts |
| acct-core | Bulk-void (discard) drafts | discard_drafts (this PR) |
| acct-core | Export ledger as plain-text double entry (view/download) | export_ledger_text |
| acct-core | Author entries in plain-text double entry | post_ledger_text |
| acct-core | Upload a bank/Ramp/QB CSV feed | import_bank_transactions |
| acct-core | AI-categorize drafted bank rows | categorize_bank_transactions |
| acct-core | Re-point a drafted bank row to an account | set_bank_transaction_account |
| acct-core | Post one drafted bank row | post_bank_transaction |
| acct-core | Post many drafted bank rows | post_bank_transaction (loop); post_drafts |
| acct-core | Bank reconciliation summary | bank_reconciliation |
| acct-core | View fiscal periods / next close start | list_periods |
| acct-core | Close every month through a date | close_period |
| acct-core | Download statements PDF | financial_statements_pdf |
| acct-core | Fund performance PDF | fund_performance_pdf |
| acct-core | Firm close grid | close_status |
| acct-core | Firm holdings across entities | portfolio_summary |
| acct-core | List LP entities with ownership | list_entities |
| acct-core | Reconcile capital accounts vs administrator | reconcile |
| acct-core | Portfolio construction view / change assumptions | portfolio_construction; portfolio_construction_update |
| acct-core | Forecast: list/create plans | forecast_list_plans; forecast_create_plan |
| acct-core | Forecast: view/edit plan (rules, overrides) | forecast_explain; forecast_update_plan |
| acct-core | Forecast: publish/approve version | forecast_publish |
| acct-core | Forecast series / returns / variance | forecast_series; forecast_returns; forecast_variance |
| acct-core | Fee links: list / set | forecast_fee_links; forecast_set_fee_link |
| acct-core | QuickBooks/Carta import: parse file & propose mappings | journal_import_accounts |
| acct-core | QuickBooks mapping: view / save | journal_import_accounts; save_journal_mapping |
| acct-core | QuickBooks: import journal as drafts | import_journal |
| acct-core | List entities (picker / switcher) | list_vehicles |
| deals-diligence | View inbound deal pipeline (filter by status/fit/source/search) | deals_list_inbound, query_deals |
| deals-diligence | View one inbound deal (analysis, founders, source email, research) | deals_inbound_detail |
| deals-diligence | Change inbound deal status / entity / assignee | deals_update_inbound |
| deals-diligence | Queue web research on an inbound deal | deals_research_inbound, deals_research_status |
| deals-diligence | Promote inbound deal to diligence (open deal room) | deals_promote_to_diligence |
| deals-diligence | View diligence deal list | diligence_list_deals, query_diligence |
| deals-diligence | Create a diligence deal (deal room) | diligence_create_deal |
| deals-diligence | View a deal room (deal, documents, latest draft) | diligence_deal_detail, diligence_list_documents, diligence_memo |
| deals-diligence | Run outside research stage | diligence_run_agent (stage research) |
| deals-diligence | Draft memo stage | diligence_run_agent (stage draft) |
| deals-diligence | Score memo against rubric | diligence_run_agent (stage score) |
| deals-diligence | View pipeline progress / agent job status | diligence_deal_detail, diligence_job_status |
| deals-diligence | View a deal's attention queue | diligence_memo |
| deals-diligence | Resolve / ignore / reopen an attention item | diligence_resolve_attention |
| deals-diligence | View checklist | diligence_checklist |
| deals-diligence | Add checklist item | diligence_add_checklist_item |
| deals-diligence | View data room documents | diligence_list_documents, diligence_document_text |
| deals-diligence | Rewrite / insert memo paragraphs | diligence_write_memo |
| deals-diligence | Finalize memo (admin) | diligence_finalize_memo |
| deals-diligence | Add a deal note | diligence_add_note |
| portfolio | View portfolio companies list | list_companies, query_portfolio(companies) |
| portfolio | View one company (profile fields) | company_detail |
| portfolio | View a company's KPI metrics | company_metrics |
| portfolio | View a metric's values | company_metrics, query_portfolio(kpis) |
| portfolio | Enter a KPI value for a period | record_metric_value |
| portfolio | Add a note on a company (@mentions notify) | add_company_note |
| portfolio | Save analyst-drafted text as the company summary | company_save_summary |
| portfolio | View a company's updates history | get_updates |
| portfolio | View a company's transactions, position summary and lot policy | list_investments, company_detail |
| portfolio | Delete a portfolio transaction | delete_investment |
| portfolio | Search company updates across the portfolio | get_updates(mode=search) |
| portfolio | Open one company update | get_updates(ids) |
| portfolio | View the portfolio sheet for an entity | portfolio_summary, query_portfolio(positions) |
| portfolio | Investments schedule as of a date (cost, FV, MOIC, IRR) | portfolio_summary(as_of), fund_performance |
| portfolio | View per-company response tracking | data_request_status |
| portfolio | Dashboard portfolio table | portfolio_summary, show_portfolio_dashboard |
| portfolio | List entities (vehicles) | list_vehicles |
| portfolio | Get an upload URL for a governing document | entity_document_upload_url |
| portfolio | List an entity's governing documents | list_entity_documents |
| portfolio | Store a governing document | add_entity_document |
| portfolio | Create a vehicle (admin-only) | setup_fund |
| portfolio | Set a vehicle's reporting profile (strategy, administrator, LP report days) | set_entity_profile |
| portfolio | View the compliance calendar | compliance_calendar, whats_due |
| portfolio | Getting-started setup checklist | setup_status, setup_fund |
| settings-admin | Rename the fund | setup_fund(fundName) |
| settings-admin | Change a member's role (admin/member) | setup_fund(team.role) |
| settings-admin | Apply an access preset to a member | setup_fund(team.preset) |
| settings-admin | Invite a team member | setup_fund(team) |
| settings-admin | Add an authorized sender (who may email updates in) | setup_fund(authorizedSenders) |
| settings-admin | See onboarding progress / getting-started checklist | setup_status |
| settings-admin | Create a new fund (first-run) | OAuth consent creates fund (oauth/consent) + setup_fund |
| settings-admin | Choose products and first entity in wizard | setup_fund(products, entities) |
| settings-admin | Skip / finish onboarding | setup_fund(finish) |
| settings-admin | Add senders during onboarding | setup_fund(authorizedSenders) |
| settings-admin | List pending approvals | list_pending_actions |
| settings-admin | View recent runs (applied/partial) with step outcomes and checks | list_runs (this PR) |
| settings-admin | Approve a staged change | approve_action |
| settings-admin | Reject a staged change | reject_action |
| settings-admin | Undo an approved run | undo_run (this PR) |
| settings-admin | Approve/reject/list via v1 REST | list_pending_actions, approve_action, reject_action |
| portal(LP) | View LP overview / my position | PORTAL MCP: portal_overview, show_my_position, portal_home |
| portal(LP) | Download my live capital statement PDF | PORTAL MCP: statement_pdf |
| portal(LP) | List/read/download shared letters | PORTAL MCP: list_letters, read_letter, letter_pdf |
| portal(LP) | List/open documents | PORTAL MCP: list_documents, get_document |
| portal(LP) | View capital call/distribution notices | PORTAL MCP: list_capital_notices |
| portal(LP) | Acknowledge a capital call ('we've wired') | PORTAL MCP: acknowledge_capital_call (write scope) |
| portal(LP) | Read messages / contact the fund | PORTAL MCP: list_messages, send_message (write scope) |
| portal(LP) | View onboarding checklist | PORTAL MCP: onboarding_status |

</details>

<details><summary>Not member actions (n/a)</summary>

| Area | Action | Why |
|---|---|---|
| acct-capital-tax | Record LP e-delivery consent / deliver K-1s / withdraw consent | No UI caller; deliver is admin-only and goes out to LPs |
| acct-capital-tax | View archived LP capital events | Archived/legacy store; live reporting uses dated positions |
| acct-capital-tax | Add/edit/delete LP capital events, switch source | Retired writes, return 410 |
| acct-capital-tax | Parse pasted LP capital events CSV (preview) | Feeds the retired lp-events write path; no UI caller |
| acct-capital-tax | Share/unshare a snapshot report with LPs | No UI caller (superseded by live-report share); admin-only |
| acct-capital-tax | Freeze the live LP report into a snapshot | No UI caller (live publish replaced it) |
| acct-capital-tax | AI-parse pasted LP data into a snapshot | No UI caller; legacy snapshot import |
| acct-capital-tax | CRUD snapshot LP investment rows | No UI caller; legacy snapshot rows |
| acct-capital-tax | Seed/refresh a management company's chart of accounts | No UI caller; charts are seeded when the vehicle is created |
| acct-core | Generate opening position from LP data (bootstrap) | legacy; no UI caller |
| acct-core | Apply an Analyst proposal as a draft | in-app Analyst plumbing; an external agent drafts entries directly |
| acct-core | Manage personal API keys | deliberate: credential minting should not be done by an agent |
| acct-core | Turn on accounting | retired route (returns 410) |
| acct-core | Attach a receipt/document to a journal entry | feature does not exist in app or API (no attachment table/route for journal entries); only entity_documents exist |
| portfolio | Start a Company Updates backfill job | operator maintenance job, admin, no UI |
| portfolio | Check backfill job progress | operator maintenance |
| portfolio | Company Updates corpus coverage/quality counts | operator diagnostics |
| portfolio | Fund group config (legacy) | legacy hand-entered fund economics superseded by ledger; no UI caller |
| portfolio | Hand-entered fund cash flows (legacy) | legacy; fund-overview notes these were replaced by ledger-derived figures |
| portfolio | AI import of fund cash flows (legacy) | legacy |
| portfolio | Mark notes as read | per-user read receipts, UI-only |
| portfolio | List team members for @mentions | UI helper; add_company_note resolves @mentions server-side |
| portfolio | Which entities a note can belong to | UI helper |
| portfolio | Save/reset dashboard entity selection | UI-only preference |
| portfolio | Chat with the in-app Analyst | the headless agent is itself the analyst; Analyst-drafted changes reach it via list_pending_actions |
| portfolio | List/save/open/delete Analyst conversations | in-app chat history, not a fund action |
| portfolio | Start page: quick actions and Analyst | entry UI for the in-app Analyst; show_home is the headless equivalent |
| portfolio | App version updates page | deployment/version info, not a fund action |
| settings-admin | Test Claude / OpenAI key | takes a raw key in the body; belongs with key entry, which is deliberately web-only |
| settings-admin | List available Claude / OpenAI models | helper for a model picker; only useful if a model-setting tool is added (then fold in) |
| settings-admin | Turn Agent access (MCP/REST) on/off; Affinity MCP on/off | deliberate: the kill switch for the headless surface itself must not be operable through it |
| settings-admin | Connect/disconnect my Affinity API key | deliberate: per-user third-party credential |
| settings-admin | Pick/clear the fund Google Drive folder; disconnect Drive | deliberate: depends on the user's Google OAuth session in browser |
| settings-admin | Browse/create Drive folders | browser OAuth picker helper |
| settings-admin | Connect Google (OAuth) | OAuth plumbing |
| settings-admin | Check email domain for existing fund / request to join a fund | pre-membership flow; no fund-scoped credential exists yet |
| settings-admin | In-app Analyst chat (sync and streaming) | the headless agent is its own model; Analyst is the in-app LLM |
| settings-admin | View/delete Analyst conversations | in-app chat history; not a fund action |
| settings-admin | App identity/meta for mobile client | client bootstrap |
| settings-admin | REST agent endpoint | this is the headless surface itself |
| settings-admin | MCP endpoint | this is the headless surface itself |
| settings-admin | Open a report link an assistant handed over | delivery mechanism for tool output |
| settings-admin | Download Claude/ChatGPT plugin zip | install artifact for the assistant |
| settings-admin | Create/revoke API keys | deliberate: credential minting; out of this area's dirs |
| settings-admin | Enroll/verify/remove MFA factor | auth/security; user's own session |
| settings-admin | Sign up / log out / activity heartbeat / sign-in branding | auth/session plumbing |
| settings-admin | OAuth 2.1 server (consent, register, token, revoke, metadata) | OAuth plumbing for MCP connections |
| settings-admin | Transcription webhook | Deepgram callback |
| settings-admin | Inbound email receivers (Postmark, Mailgun) | webhook receivers; NOTE: the emailed-receipts feature would hook classification here - currently pipeline treats mail as company updates |
| settings-admin | Cron: access expiry, affinity sync, company-updates backfill/OCR, deal research, deals digest, entity-docs OCR, memo-agent worker, ops reminders | scheduled jobs |
| settings-admin | Public deal submission form | unauthenticated public form; members use deals_create_inbound |
| settings-admin | PWA icon / OG image / CSP report | static assets / browser telemetry |
| settings-admin | Support / docs page; version + auth email templates sections | static content, no API |
| portal(LP) | View/disconnect connected assistants | managing the connector from within itself |
| portal(LP) | Activate LP account | account activation/auth |
| portal(LP) | LP portal AI analyst | in-portal LLM; the connected assistant replaces it |
| portal(LP) | GP header: do I also have an LP account | UI switch link |
| portal(LP) | Investor connector MCP endpoint | separate LP-facing MCP with its own OAuth audience ('portal'); distinct from /api/mcp manager registry |

</details>
