# Portfolio, by Hemrock — Feature descriptions

- Project overview at [README](./README.md)
- Detailed feature descriptions at [FEATURES](./FEATURES.md)
- Technical deployment details at [DOCS](./DOCS.md)
- Fund accounting setup and double-entry reference at [ACCOUNTING](./ACCOUNTING.md)

## How It Works

The fastest way to get data flowing is to forward reporting emails to the inbound address shown in Settings. You can forward emails yourself, or give the inbound address to your founders or fund analysts and ask them to CC or send reports directly. Every email that arrives at that address is automatically parsed: the system identifies which company it's from, extracts the metrics you've defined, and flags anything it's unsure about for your review.

Not everything arrives by email. When someone sends you a link to a Google Sheet, Docsend deck, or any other hosted file, download it and upload it through the Import page. The same goes for PDFs, Excel workbooks, Word docs, PowerPoint decks, CSVs, and images — anything you can download, you can import. The AI pipeline processes uploads identically to inbound emails.

Once data starts flowing, the Portfolio dashboard gives you a real-time view of every company, the Review queue catches anything that needs a human decision, and the Analyst — available on every page — lets you ask questions about company performance, portfolio trends, and investment data through a persistent chat interface that remembers past conversations.

## Portfolio

The Portfolio page is the main dashboard and your starting point for monitoring the fund. It shows all active companies with key headline metrics (such as MRR and cash balance) so you can quickly scan the health of the portfolio without clicking into individual companies. Companies are displayed as cards with their most recently reported figures, sparkline charts, and badges for stage, industry, and vehicle.

Filter by vehicle and sort by name, cash position, or other criteria. A shared notes section at the bottom lets team members post fund-level observations — market commentary, cross-portfolio themes, reminders for the next IC meeting.

![Portfolio Dashboard](public/screenshots/dashboard.png)

### Company Detail

Clicking a company opens its detail page. At the top you'll see the company name, headline metrics, and badges for stage, industry, and vehicles. Admins can edit the company's name, aliases, stage, industry, founders, overview, and other details.

The **Analyst** card generates a summary based on all available data — reported metrics, email content, uploaded documents, and previous summaries. The AI acts as a senior analyst preparing a portfolio review memo: it highlights current performance, trends, strengths, risks, and follow-up questions. You can regenerate the summary at any time, clear it to start fresh, or upload additional context documents directly from the card. If your fund has multiple AI providers configured, a provider selector lets you choose which AI to use.

Below the Analyst is the **metrics section**, where each metric has its own chart card. Charts show data points over time, color-coded by confidence level. Click any data point to view details and edit or delete values. You can also add data points manually using the "Add" button on each card. An export button lets you download all metric data as a CSV.

A **documents section** lists all files associated with the company — both uploads and email attachments. These documents are available to the Analyst when generating summaries. Individual file uploads are limited to 20 MB.

The **Investments section** tracks the fund's transaction history with the company — investment rounds, proceeds from exits or distributions, and unrealized gain changes. It displays summary metrics (total invested, FMV, MOIC, total realized) along with a detailed transaction table.

A **notes panel** on the right side lets your team leave company-specific observations visible to all members.

![Company Detail](public/screenshots/company.png)

## Review

When inbound emails are processed, the AI pipeline sometimes flags items that need a human decision. These appear in the Review queue. Common reasons: a new company name was detected, a metric value was extracted with low confidence, a reporting period was ambiguous, or a metric couldn't be found in the report.

Each review item shows the issue type, the extracted value, and context from the source email. You can accept the value as-is, reject it, or manually correct it. For new company detections, you can create the company or map it to an existing one.

The review badge in the sidebar shows how many items are waiting. Once all items for an email are resolved, its status moves to "success." The system is designed to err on the side of flagging rather than silently writing bad data.

![Review Queue](public/screenshots/review.png)

## Inbound

Inbound shows every email received and processed by the system — the audit trail for all automated report ingestion. Each row displays the sender, subject line, matched company, and processing status. Filter by status and date range, and click any email to see the full processing result: identified company, extracted metrics, review items, raw email body, and attachments.

If an email failed processing, you can see the error in the detail view. For emails needing review, resolve flagged items directly from the detail page. A **Process Email** action lets you rerun the entire AI pipeline on an email — useful after adding companies, updating metrics, or changing AI providers.

If file storage is connected (Google Drive), emails and attachments are saved into company-specific folders automatically.

![Inbound](public/screenshots/inbound.png)

![Email Detail](public/screenshots/email-detail.png)

## Import

Import lets you process reports manually when they arrive outside the normal email flow. Upload file attachments (PDFs, Excel spreadsheets, Word documents, PowerPoint decks, CSV files, and images up to 20 MB each), paste email text directly, or combine both. The system runs the same AI pipeline as automated inbound processing.

You can also paste data covering multiple companies at once — rows from a spreadsheet or CSV. The system will parse the data, create new companies if needed, add new metrics, and populate values. This makes it easy to bulk import historical data or onboard an entire portfolio in one step.

Investment transaction data can also be pasted — rounds, proceeds, valuations, and share prices — and the AI will match entries to your portfolio companies.

![Import](public/screenshots/import.png)

## Investments

The Investments page provides a fund-level view of all investment transactions across the portfolio. Two tables organize the data:

**Vehicle summary** — one row per vehicle (e.g. Fund I, Fund II) showing aggregate invested capital, current cost, realized and unrealized values, total value, gain/loss breakdowns, gross MOIC, realized/cost MOIC, unrealized/cost MOIC, and gross IRR. When fund cash flows are configured, computed LP metrics (TVPI, DPI, RVPI, Net IRR) appear alongside each vehicle.

**Company detail table** — every company with its investment cost, current cost, proceeds, unrealized value, total value, MOIC, IRR, and percentage allocation. The first column (company name) is sticky during horizontal scrolling. Both tables support column sorting, and a vehicle filter lets you focus on a single vehicle.

Realized/Cost MOIC is calculated as realized proceeds divided by the cost basis exited. Unrealized/Cost MOIC is unrealized value divided by current cost (total invested minus cost basis exited). These provide a more precise view of returns relative to the capital actually at work, rather than total invested capital.

Two charts sit above the tables and follow the same filters. **Fair value and cost by holding** ranks what is still held: the bar is fair value and the tick is current cost, so markups and markdowns read at a glance. **Invested and total value by multiple** sorts every holding into a band by gross multiple and shows the capital that went into each band beside what it has returned and is still worth.

![Investments](public/screenshots/investments.png)

## Funds

The Funds page is a per-vehicle performance overview, with every figure derived from the capital accounts rather than typed in. It reads the same whether a vehicle runs on light capital tracking (no double-entry books) or a full ledger, because both feed the same capital accounts.

**Charts** — with two or more vehicles, **called against committed** shows how much of each commitment has been drawn, and **total value against called** stacks distributions and NAV against a tick at called capital. The second opens on multiples (DPI and RVPI against 1.00x), since vehicles differ in size, and switches to dollars. Both follow the search and the lens.

**Filters and lens** — search vehicles, filter by source (Fund Accounting or LP tracking), set an "As of" date, and toggle **Net to LP** (the LP-class partners' own accounts, already net of the carry the close accrued to the GP) against **Whole fund** (every partner, GP included). The toggle appears only when there is a GP class to carve out.

**Summary cards** — Committed, Called, Distributed, NAV, TVPI, and DPI, totaled across the vehicles currently in view.

**Vehicle table** — one row per vehicle with Vintage, Committed, Called, Not called, Distributed, NAV, DPI, RVPI, TVPI, and IRR, sortable on any column. Click a vehicle to open its detail page.

Capital is recognized when it is called, so called capital may be unfunded. Carry is exact rather than estimated: the period close accrues it to the GP's own account, so an LP's reported numbers are already net of it, with no carry-rate heuristic and nothing to keep in sync.

A vehicle gets its capital one of two ways, and both land in the same accounts. **Capital tracking** records what moved each LP's capital (contributions, distributions, marks) with no double-entry books, enough for an SPV or a fund whose admin sends a quarterly statement. The **full ledger** adds a chart of accounts, journal entries, capital calls against a receivable, period closes that accrue carry, and financial statements.

![Funds](public/screenshots/funds.png)

**Portfolio construction.** A per-vehicle plan of what happens next: investable capital after fees and expenses, the deals still to do and what each costs, and what exit the portfolio has to reach. Forecast proceeds are stated per company and per planned deal, by ownership at exit or by multiple, and the model reports gross and net MOIC with an ownership sensitivity. **Pacing** lays that plan on the calendar — how many years the remaining checks are written over, the follow-on lag, the hold periods, the horizon — and the page shows the J-curve (DPI and TVPI by year, the fund's actual history solid and the forecast dashed), forecast cash flows by year, and a since-inception net IRR. **Monte Carlo** spreads the outcomes: a write-off rate and a dispersion around each deal's forecast, sized so the mean still equals the forecast, exits sliding within a window, a seeded generator so the bands reproduce. It returns percentile bands over time, a histogram of final TVPI, and the probability of reaching a target multiple, of losing capital, and of one deal returning the fund. Both layers are stated per deal where the fund wants them to be: a company or planned deal can carry its own investment year, years to exit and follow-on timing, and its own loss rate, dispersion and exit spread, and the fund-wide values fill in whatever it leaves empty. Nothing is defaulted: pacing and dispersion are questions the page asks, and until they are answered it shows the deterministic plan alone.

## Letters

Letters helps you generate quarterly update letters for your limited partners. Using AI and your portfolio data — reported metrics, company summaries, investment performance, and team notes — the system drafts professional LP communications scoped to a specific vehicle and reporting period.

To create a letter, select the year, quarter, vehicle, and template. Optionally toggle "year-end summary" for Q4 letters and add custom instructions to guide the AI. A preview step shows the companies and data that will be included before generation begins. You can upload a previous LP letter (.docx or .pdf) and AI analyzes it to match your writing style, tone, and structure, or use the built-in default template. Templates are reusable across letters and managed from the Templates dialog on the Letters page.

The AI generates a narrative for each company in the vehicle, drawing on reported metrics, recent trends, company summaries, investment data, and team notes. A portfolio summary table with investment performance is also generated. The full letter is assembled from these sections.

After generation, the letter opens in an editor with two views: "Sections" shows each company narrative individually for targeted editing, and "Full" shows the complete assembled letter. Edit narratives inline, regenerate individual company sections or the entire letter, and add per-company or global custom prompts to refine the output. Per-company prompts can either add to or replace the default generation prompt. When finished, export the letter as a .docx file for final formatting and distribution, or export directly to Google Drive if connected.

![Letters](public/screenshots/letters.png)

## LPs

LPs is where you track and report on your limited partner positions across every vehicle. It's a layered capability, off by default: turn on **LP capital tracking** to track LP capital, and optionally the **LP portal** and **LP documents** on top of it — independent of whether you keep full fund accounting.

**The LPs page is a live aggregate.** Every LP across every vehicle, rolled up to the investor, as of any date — commitment, paid-in, distributions, NAV, DPI, TVPI, IRR. It reads live from the underlying data (pasted positions or the ledger), so it's never stale. Expand an investor to see their per-vehicle lines. A member who invests through your GP or associate entity is looked through to their share of what that entity holds.

**Two charts lead the table**, drawn from the investors it lists: called against committed, and total value (distributions, then NAV) against called capital, in dollars or as multiples. The ten largest are shown, the rest folded into one row that expands in place.

**Capital tracking, per vehicle.** On the LP capital accounts page, pick a vehicle and see its capital accounts. For a vehicle you don't keep books on, you feed it by pasting a statement — commitments, called/paid-in, distributions, NAV — and AI maps the columns into a **dated position**. Every import is stamped with its as-of date, so you keep a record over time: the set of dates *is* the history, and the capital account as of any date is the latest position on or before it. You can also type figures in or edit them by hand. Movements (the roll-forward lines) are derived by diffing consecutive dates, so what you store is exactly what you were given — no decomposition, nothing to drift. When a vehicle is on the ledger instead, the same page shows the same accounts, sourced from the books.

**Report cards, live or frozen.** Print investor report cards — the per-investor summary aggregated across vehicles — straight from the live data, one at a time or the whole list at once, in your browser's font. Or freeze a **snapshot**: a point-in-time set of positions kept exactly as it was, in an admin-only archive, with its own bulk PDF printing and Excel export. Snapshots stop *driving* the numbers (that's live now) but remain the record for anything you've already sent. Every report footnotes when its data was last updated — **per vehicle**, since vehicles report on irregular cadences.

The snapshot archive keeps all the original tools: create a named snapshot, paste-import into it, inline-edit, group investors under a parent, merge duplicates, filter vehicles, configure a header/footer, and batch-print or export to Excel.

**Onboarding.** LPs get in by invitation — one at a time, or a pasted sheet of investors, emails and authorized users, previewed before anything sends — and activate with a code and a password on a link that does not expire. The accounts list shows who is invited, active or disabled, when they last signed in and whether the invite was delivered, with resend and disable. Signing happens off platform; the platform keeps the record. Tick the documents your fund requires of every LP entity (subscription agreement, LPA signature page, W-9 / W-8, identity and entity KYC, beneficial ownership, accreditation, wire instructions, side letter, electronic K-1 delivery consent), and every entity shows where it stands on each. Inviting an investor creates their entity, which the LP can rename to the legal name; an entity that does not belong on the checklist (the GP, by default) is excluded from requests and reminders. Wire instructions are verified by a recorded callback, never by filing, and replaced instructions the fund had verified raise a separate alert; K-1 electronic delivery consent is given by the investor on the checklist, disclosure and all, and recorded on the Tax page. LPs **upload executed copies from their portal**; the fund verifies each one, with an expiry where it lapses, sends it back with a note, or waives it, and can email every LP a list of what they still owe. An onboarding document is visible to that investor alone and is never text-indexed. A verified tax form's facts are recorded on the Tax page, where they gate the K-1 — the full TIN stays in the signed form. **Sort a batch** reads a folder of executed documents on your own server — PDF or Word text, OCR for photos and scans — and proposes the kind and the entity for each, with the signature date and stated commitment it found and a flag when that commitment disagrees with the one on file; no model is called, the text is not kept, and you confirm every row. Uploads are scanned before they are recorded, emailed to the fund, logged in the LP's activity, and kept as a set per item; a send-back is emailed to the LP with the note; every review action is in an audit trail; and the daily digest counts down closings, nags on uploads awaiting review, and flags documents about to expire. An LP can remove an upload until it is reviewed, sees what is still needed on their landing page, and the notice email on the entity is Cc'd on every send. The **investor record** holds what a subscription document is filled from — entity type, jurisdiction, address, notice email, signatories — and a relationship contact that also catches onboarding requests for investors without a portal account. **Closings** give the checklist its deadline: name and date each close on the vehicle's Allocation terms page and admit partners at it, and every entity's onboarding is due by its close — counted down for the fund, stated to the LP, and the fact a fee commencement date or a late-closer equalisation will read.

**The portal's Notices tab and messages.** An LP sees every capital call and distribution on their entities with its status from the fund's books, the notice once published, the receipts filed against it, and a *We've wired* form to record when they wired and with what reference — which shows on the GP's call card and helps the bank matcher tell two partners owing the same amount apart. Messages run both ways: a question sent from the portal's Contact form lands in the LP Portal page's inbox, where the fund replies (emailed to the LP and their authorized users, shown under the question in the portal); an **announcement** goes to chosen LPs, or all of them, with nothing attached, after the same review of every address.

## Accounting

Accounting gives each of your vehicles — a fund, an SPV, a direct deal, a GP entity — a real double-entry ledger, and turns it into the numbers your LPs actually see. It is optional: turn it on for one vehicle, or none, and the rest of the platform works exactly as before.

> Setup guide, every entry type in T-account and plain-text form, and the checks that should always hold: [ACCOUNTING](./ACCOUNTING.md)

**Starting a vehicle's books.** There is no setup step: a vehicle gets the chart of accounts for its kind when it is created (one created earlier gets it the first time its books are opened). Bring in history from the bank feed, or take over at a cutover date with each LP's opening capital balance. GP and associate entities get their own chart (Investment in Fund, members' capital, carried interest income) rather than the fund chart, because they keep different books. Investment transactions are the one writer of investment value: recording a purchase, exit or mark on a company posts its journal entry, and an entry written by hand or imported on an investment account is adopted as the matching transaction.

**Bank transactions.** Paste or upload a CSV/TSV export from your bank, Ramp, or QuickBooks. Columns are matched automatically, rows are de-duplicated, and each becomes a balanced draft entry for review. AI categorization suggests the account and entry type for a whole batch at once. An inflow can be booked as a **capital call** — funding an LP's open call, or splitting across every LP pro-rata by commitment — and an outflow as a **distribution**, split by capital balance so it lands in each partner's capital account rather than a pooled one. Nothing posts itself; every entry waits as a draft.

**Journal.** Every entry, in plain double-entry form, debit and credit columns. **New entry** is a menu: a plain entry, or one of the standard ones — management fee from the fund's rate and each partner's terms, partnership expense, realized gain, distribution or carry by partner — each built from its inputs and shown before it is written. An investment is marked to fair value from the company, as a valuation update. The entry form has a type-ahead account picker, the entry's type (which decides the line it lands on in each partner's capital account), a reference, and a *Reverses on* date for an accrual. A posted entry can be **reversed** (a dated contra-entry, saved as a draft to review, the original stays posted), **duplicated**, unposted to edit, or voided. A posted entry is never silently deleted, and an entry inside a closed period cannot be changed at all until the period is reopened — enforced in the database, not just in the app.

**Adjusting entries and the tax book.** Any entry can be flagged *adjusting* — a period-end correction, usually at the preparer's direction — and the journal lists those on their own, as does the tax package. The journal's Book switch shows the tax book: the book-to-tax adjusting entries the tax run wrote, read-only. Financial statements, the trial balance, the register and every export take a *Tax basis* switch, which reads the ledger plus the tax overlay together — what Schedule L and M-1 reconcile to — and says so on the workbook cover and the PDF header.

**Individuals.** A vehicle can be an *Individual / angel* — a person investing for their own account, or their single-member LLC. It keeps a fund's investment books (per-company cost and unrealized, marks, the schedule of investments) with one owner's equity instead of partners' capital and an expense chart shaped for a personal return. The period close rolls net income into the owner's capital with nothing to allocate — the same owner's-equity close a management company gets — and the pages that only mean something with partners are hidden. **Realized gains by lot** on the Tax page, and in the tax package, is the Schedule D and Form 8949 input: each disposal, the lots it consumed under the fund's lot method, proceeds, basis, gain, short- or long-term. **Vendors** are the payee on an entry — chosen on the form, or created from the counterparty on a bank import or the Name column of a QuickBooks journal — and the **1099 worksheet** on the Tax page, and in the tax package, is cash paid per vendor for the year with the reportable rows and the ones still missing a W-9. The **Firm overview** puts every entity's books on one page: closed through, drafts waiting, bank rows open, trial balance tied.

**Tax.** A page per vehicle for the year's tax work: the year's status with close and reopen; the derived book-to-tax adjustments with their rationale and a Post to the tax book; the adjusting entries flagged in the books; the K-1 package with generate, finalise, amend, the workbook download and the state worklist; partner tax forms and who is blocking a K-1; the K-1s underlying funds still owe; and the tax package download. Each section says when it needs access the caller does not hold — K-1 packages contain the carry.

**Plain text.** Author entries in the double-entry text format — the format the period close snapshots — checked against the chart as you type, and post them in one go, as drafts or posted. The vehicle's ledger downloads as text, and can be shown alongside to copy from.

**General ledger.** One account at a time, the way a bank statement reads: the balance carried in at the start of the period, every posted line with the accounts on the other side of it, a running balance, and the closing balance — which is that account's trial balance figure to the cent. Every line on a statement, every row of the trial balance and every posting in the journal links to it, and "Save & post" lands you on the register of the account you just hit with the new entry highlighted. A register is a URL, so it can be sent.

**Capital accounts.** A per-partner roll-forward — beginning capital, contributions, distributions, fees, expenses, income, realized and unrealized gains, FX translation, carried interest, ending capital — derived entirely from the ledger, so it always ties. Issue capital calls (recognized at the call, with the receivable cleared when the wire arrives), track called / funded / unfunded per LP, and publish per-partner **capital account statements** as PDFs straight to the LP portal.

**Calls and distributions, end to end.** Each issued call and declared distribution reads *open*, *partly funded* or *funded* (paid, for a distribution), with an *overdue* flag against its due date — derived from the ledger at read time, oldest call first, so it never needs advancing and a corrected wire corrects every status. A fund-wide distribution is split **through the vehicle's waterfall**: capital back to the LPs, then the preferred return, then the GP's catch-up and carry, with the tiers shown before you declare and stored with the register; carry posts as its own entry so it files against the accrued carry rather than reading as a return of the GP's capital. (A vehicle with no carry terms still splits pro-rata by capital balance.) **Notices** render one PDF per partner from the frozen register line and go out in one step — published to each partner's portal, emailed as a link, an attachment or both — after a review of the exact To and Cc for every partner. **Receipts** acknowledge what arrived against a call and when, for the lines whose money landed since the last receipt. Every send is logged, so "was this partner emailed the notice" is a question with an answer. Calls with money still outstanding join the daily ops-reminders digest three days before they are due. A capital-tracking vehicle gets the same register and notices; there funding is recorded on the line by hand rather than from a bank feed.

**Capital tracking (no ledger required).** Not every vehicle needs full books. An SPV, a direct investment, or a fund whose administrator sends you a statement can instead be tracked as **dated positions** — paste the statement (or type it in) and it's stored as of a date, building a history over time. Those vehicles produce the same capital accounts, the same statements, and appear in the same live LP report as a fully-booked one — just with fewer lines, because there was no close behind them. The capital-tracking pages live in the LPs section and work whether or not fund accounting is on. You can promote a vehicle to a full ledger later.

**Allocation terms.** How the close splits each category across partners: the allocation basis, each partner's commitment over time (effective-dated, including transfers between LPs), and who bears which category — a GP entity that pays no management fee, a side letter with a negotiated rate. Carry terms are set per vehicle: none, a straight split, or a European waterfall with a preferred return and catch-up.

**Period close.** The single place allocation happens. Close *through* a date; the span is split into calendar months and each is allocated and locked in turn, so gaps are impossible. The close allocates income and expenses to each partner's capital account, accrues **interest on convertible notes**, and accrues **carried interest** on unrealized gains — as if the fund liquidated at that period's NAV, which is what keeps every LP's reported NAV net of what the GP would actually take. Reopening a period reverses its allocation exactly, voiding rather than deleting, and periods must be reopened newest-first.

**Schedule of investments.** Each position at cost and fair value, with its unrealized gain and its share of net assets, broken out by country, industry, and asset type. Rows come from your portfolio tracker; the ledger is the control total, and any variance between them is surfaced rather than hidden.

**Financial statements.** Balance sheet (statement of assets, liabilities and partners' capital), income statement, statement of cash flows, and statement of changes in partners' capital. Out-of-balance books are reported as a blocker, not buried.

**Exports and the tax package.** Every statement set downloads as an Excel workpaper (trial balance with a column pair per compared period, statements, partners' capital, schedule of investments, cash flows, and a general ledger detail that opens each account at the balance carried in and closes to the trial balance) or as a PDF. The journal downloads as CSV, Excel, or in the layout of QuickBooks' Journal report — the layout the migration wizard reads, so it round-trips — and the chart of accounts as CSV. **Tax package** bundles the year for the preparer in one ZIP: workpapers with the prior year beside it, the statements PDF, the general ledger, both journal files, the chart, the finalised K-1 workbook when one exists and the caller may see the carry, and a README saying what is closed and what still ties. It is rebuilt from the ledger on every download; nothing is stored.

**Live capital report.** The LP report, derived from the books as of any date rather than frozen at import time — across every vehicle, with each LP's commitment, paid-in, distributions, NAV, DPI, TVPI and IRR. A member who invests through your GP or associate entity is **looked through** to their share of what that entity holds: capital follows their ownership, carried interest follows their carry points, and the two are allowed to differ (a partner can hold carry points and no commitment at all). You can compare a live report against any stored snapshot, line by line, to see exactly where the two disagree.

**AI assistant.** An assistant scoped to the accounting section — read the books, interpret a statement, reconcile an account, draft an entry. It proposes; it never posts. Everything it produces lands as a draft for you to review. There is also an API-key-authenticated agent endpoint (REST and MCP) so an external agent can work against your books.

## Management company

The firm's own operating entity, on its own books — the company that employs the team, collects the management fee and pays the rent, as opposed to the funds it manages. Off by default; switch it on in Settings → *Feature visibility*.

It is a separate section rather than another row on the Funds page because it is a different kind of thing. A management company has no commitments, no NAV, no TVPI and no limited partners, so every column of a fund performance table is a dash — and the questions a firm actually asks about it are different ones.

**Its own chart of accounts.** Seeded when you set one up: cash, receivables, prepaid and fixed assets, payables, payroll liabilities, deferred fee revenue, members' capital and draws, fee and reimbursement income, and an operating expense structure that starts with four separate compensation accounts. A fund chart offers partners' capital, investments at cost and unrealized appreciation, and no salaries line at all.

**The dashboard.** Cash across each bank account, monthly cash burn (depreciation excluded, because it is not money leaving the building) and the runway that implies; revenue and expenses **by quarter**, with the empty quarters drawn rather than skipped — a manco's revenue arrives in four lumps a year, so a missed or late fee should look like a hole, not a flat line; and expenses ranked by account with each one's share.

**Intercompany, from either side.** A fund's or GP entity's Admin page shows its charges with the management company in its own words — they owe us, we owe them, they billed us — with the same record and settle actions, for a member who holds the management-company grant. One set of postings, two points of view.

**Intercompany.** A charge between two entities of the same firm is recorded once and posts **both sides** — the receivable and the fee income on the management company, the expense and the payable on the fund — linked so they can be reconciled, with a separate settlement when the cash actually moves. Balances are shown per counterparty, due-from and due-to kept apart rather than netted, and read from the ledger rather than summed from the register, so a manual correcting entry is reflected without anyone amending a row.

**The same books everything else uses.** Journal, bank feed, financial statements, period close and the QuickBooks general-ledger import are the same tools a fund uses, scoped to the entity — the import's mapping proposer knows the management-company vocabulary, so payroll, benefits, occupancy and technology accounts arrive already matched.

**Its own access grant.** A management company's ledger carries salaries, bonuses and partner draws, and unlike a K-1 none of it is derivable from a fund's books. So it is a separate grant, granted per person, and it starts at *no access* for everyone — granting someone fund accounting does not hand them the partners' compensation. Enforced by the vehicle, not just the page: an accounting API asked for a management company refuses it.

> The chart in full, the intercompany entries in T-account form, and how the boundary is enforced: [ACCOUNTING](./ACCOUNTING.md#management-companies)

## Compliance

Compliance helps fund managers stay on top of regulatory filings, tax deadlines, internal compliance requirements, and fund reporting obligations. It provides a calendar-based view of everything due throughout the year, tailored to your fund's specific profile and registration status.

Start by completing a short questionnaire about your fund — registration status, AUM range, fund structure, Reg D exemption type, state presence, and a few other details. The system uses your answers to automatically determine which compliance items apply, which need further review, and which you can safely dismiss. If your fund profile changes, update the questionnaire and the calendar adjusts accordingly.

All applicable items appear in a monthly calendar organized by deadline. Items are color-coded by category — SEC filings in amber, tax filings in green, internal compliance in blue, fund reporting in purple, state compliance in rose, CFTC in orange, and AML/FinCEN in red. Quarterly items like partnership expense reviews and access person disclosures appear in each quarter independently, so you can track and dismiss them separately. Certain event-driven filings like Form D and Blue Sky appear only in the months where your fund has committed capital entries, derived automatically from fund cash flows data.

When you finish a filing, mark it as done by dismissing it for the year or quarter. You can filter the view between active items, dismissed items, or all items to see what's been completed and what remains. An all-items view provides a comprehensive list of every compliance item organized by category, with each item showing its frequency, deadline, applicability, filing system, and any relevant notes or alerts.

Save links to filing portals, regulatory accounts, and reference documents alongside your compliance items. Each link can optionally be associated with a specific compliance item, and associated links appear on that item's detail card for quick access during filing season.

The system ships with a curated registry of compliance items covering SEC filings (Form ADV, Form PF, Form 13F, Schedule 13G, Form 13H, Form N-PX), securities offerings (Form D, Blue Sky), CFTC exemptions, California diversity reporting, tax filings (Form 1065, K-1s, Form 7004), internal compliance (access person disclosures, annual compliance review, privacy notice), AML/FinCEN requirements, fund reporting (quarterly financials, valuations), and partnership expense allocation.

![Compliance](public/screenshots/compliance.png)

## Asks

Asks lets you send reporting request emails to portfolio companies. Compose a message, select which companies should receive it, and send it out. The system tracks each request so you know what was sent and when.

The email composer supports a customizable subject and body, plus optional CC and BCC lists (comma-separated) that are copied on every email in the send. Each request is logged with its recipient list, the CC/BCC used, send timestamp, and delivery results. When companies reply to your ask email with their report, those replies flow into the Inbound pipeline automatically.

![Asks](public/screenshots/asks.png)

## Analyst

The Analyst is an interactive chat interface available on every page — company detail, portfolio dashboard, investments, asks, and notes. Powered by AI, it acts as a senior venture capital analyst with full access to your data, answering questions, surfacing insights, and helping you prepare for board meetings and IC discussions.

> The Analyst feature, like all the AI features, are scoped to your LLM API keys, so your interactions, questions, and built context are kept within your AI and your database.

On a **company page**, the Analyst has access to that company's reported metrics, email content, uploaded documents, previous summaries, investment transactions, portfolio peer comparisons, and your team's internal discussion notes. Ask it to analyze performance trends, compare the company to peers, identify risks, draft summaries, or interpret financial data from reports.

On **portfolio-wide pages**, the Analyst has access to fund-level data across all companies — investment amounts, FMV, MOIC, and team discussion notes. Use it to compare companies, get portfolio-level insights, or surface cross-portfolio themes.

**Persistent conversations** — chat history is saved to your account. Close the panel, navigate away, or close the browser — click the clock icon to open your conversation history and resume any previous thread. Conversations are scoped: company chats stay with that company, portfolio chats have their own history.

**Conversation memory** — when you start a new conversation, the system summarizes your recent past conversations in the same context and injects them into the AI's prompt. The Analyst remembers what you've discussed before — key questions, conclusions, and concerns — without you needing to repeat context.

**Team notes as context** — the Analyst incorporates your team's internal discussion notes into its analysis, so it's aware of qualitative observations alongside the quantitative data.

## Dashboards in Claude and ChatGPT

Open the fund's dashboards inside the assistant you already use. Ask Claude or ChatGPT to "show me the portfolio" and the portfolio overview appears in the conversation: fair value, cost and gross MOIC, fair value against cost by company, and the holdings table. Click a company to see its position, its KPI history as charts and its rounds. Ask for the balance sheet and get the statements for a period, with the balance check. Ask who has funded and see every investor's paid-in capital against their commitment.

Each dashboard expands to full screen, follows the assistant's light or dark theme, carries the fund's own accent colour, and works on a phone. The assistant has the same figures as text, so "which of these is marked below cost?" is answered from what is on screen.

**Save a dashboard** by asking ("save this as Q3 LP review"), and reopen it in any later conversation, in either assistant. A saved dashboard keeps the view and its filters, not the numbers, so it always opens on current figures. Share one with the fund and colleagues can open it too, each seeing only what their own access allows.

Everything runs against your own deployment, signed in as you. Setup is in [DOCS](./DOCS.md#dashboards-in-claude-and-chatgpt).

## Notes

Notes are available on each company's detail page, on the Portfolio dashboard, and on the dedicated Notes page. They provide a lightweight way for team members to share observations, context, and follow-up items.

Notes support **@mentions** — type @ while writing to see a dropdown of team members. You can also **follow companies** to get notified about notes on companies you care about. Notification preferences (all notes, @mentions only, or none) are managed in Settings.

Team notes are also fed into the Analyst as context, so the Analyst is aware of your team's discussions when answering questions.

![Notes](public/screenshots/notes.png)

## Interactions

Interactions gives GPs a searchable log of all conversations and introductions with portfolio companies. BCC the fund's inbound email address on any conversation, and the system automatically classifies it as a CRM interaction — not a metrics report — using a simple heuristic: emails from fund members go to the interaction pipeline, emails from authorized senders go to the metrics pipeline.

For each interaction, AI generates a short summary, detects whether the email contains an introduction between parties, and extracts the names and context of anyone being introduced. Interactions are linked to portfolio companies when the AI can identify them from the email content.

The Interactions page shows all logged interactions with filter tabs for **All** and **Intros**. Each entry displays the date, linked company, subject, AI summary, and an intro badge when introductions were detected. Expand intro details to see names, emails, and context of introduced contacts.

On each company's detail page, a **Recent Interactions** section shows the latest interactions for that company, with intro entries highlighted. The fund's inbound email address is shown at the top of the Interactions page for easy copy-and-paste into BCC.

![Interactions](public/screenshots/interactions.png)

## Deals

Deals is the inbound side of deal flow — cold pitches, partner-forwarded intros, and scout submissions arrive at your existing inbound email address and get screened against your fund's thesis before they reach a partner's inbox.

Every inbound email runs through a content-aware classifier that decides between four destinations: **reporting** (portfolio metrics, the existing pipeline), **interactions** (CRM-style emails from fund members), **deals** (a company pitching the fund), or **other** (newsletters, recruiter spam, vendor pitches). Sender identity is a strong signal but not a hard rule, so a partner forwarding a cold pitch lands in Deals where it belongs, and a portfolio founder pitching a side project gets routed correctly. When the classifier is unsure, items go to a Review queue with the top two predicted destinations for one-click resolution.

For each pitch routed to Deals, a single AI call extracts company name, founder, intro source (referral / cold / warm intro / accelerator / demo day), referrer when applicable, stage, industry, raise size, a 100–150 word company summary, and a thesis-fit analysis with a fit score (strong, moderate, weak, out of thesis). Out-of-thesis pitches auto-archive and surface in a weekly digest email so partners can sanity-check without eyeballing every cold pitch. Founders can also submit pitches directly via a public form at a per-fund URL — no signup, file uploads supported, honeypot + rate-limited.

The Deals page lists active pitches as a sortable table or a kanban board (drag-and-drop across status columns: new, reviewing, advancing, met, passed). Click a pitch to see the summary, thesis-fit analysis, source email, attachments, founders, intro source, and a deal-scoped Analyst chat that knows the pitch and your thesis. Settings → Deals controls the investment thesis, screening prompt, public submission token, and the Known Referrers list (scouts and friends-of-fund whose intros bias toward Deals).

## Diligence

Diligence is the pre-investment workflow: when a deal is worth real time, you create a diligence record, upload the data room, and run a schema-driven agent that ingests the documents, conducts external research, asks partner Q&A, drafts a structured memo, scores it per your rubric, and renders to Word or Google Docs.

The agent is operated by **seven YAML/MD configuration files** ("schemas") that partners edit per-fund through an in-app editor: instructions (operating manual), rubric (scoring dimensions), qa_library (partner Q&A pool), data_room_ingestion (per-document extraction rules), research_dossier (external research scope), memo_output (memo structure), and style_anchors (metadata for uploaded reference memos). The schema editor is a plain-text editor with inline YAML syntax validation and version history; rolling back to a prior version is one click. Each fund seeds defaults on first use and customizes from there.

**Style anchors** are uploaded reference memos that teach the agent your firm's voice. Drop in 3–8 prior memos, tag each with vintage, sector, voice representativeness, and partner notes, and the agent uses them to match structure and tone during drafting. A confidence indicator (unavailable / preliminary / reliable / robust) reflects how many memos you've uploaded. Reference memos teach voice — they never supply facts to a new memo.

The agent runs in six stages, each producing structured output stored on a memo draft:

1. **Ingest** — classify each document, extract claims with provenance, run a gap analysis against expected document types.
2. **Research** — verify or contradict company-stated claims, build a competitive map (named-by-company vs. identified-by-research), compile founder dossiers, list research gaps.
3. **Q&A** — pull batches from the Q&A library, apply skip logic against ingestion + research, capture partner answers.
4. **Draft** — assemble paragraphs per the memo_output schema with paragraph-level source citations. Recommendation and team scoring are partner-only and can never be set by the agent (DB constraint enforces this).
5. **Score** — rate each rubric dimension; partner-only dimensions (e.g. team) get null score with the rationale field populated as supporting material.
6. **Render** — markdown (inline), `.docx` download, or native Google Doc.

The memo editor is a two-pane view: rendered memo on the left with inline citation markers and visual treatment for projections, unverified claims, and contradictions; paragraph inspector and a partner-attention sidebar on the right. Partners edit any paragraph (it flips to `partner_edited` origin), update rubric scores by hand, work through the attention queue (must-address / should-address / FYI), and finalize when ready — finalizing locks the draft.

Across all your active deals, the **Inbox** aggregates open partner-attention items so you can triage them in one pass instead of clicking through each deal. The **Analytics** view shows the agent funnel (created → ingestion → research → Q&A → draft → finalized → won) with drop-off percentages, time-in-stage medians, win/loss by sector, and throughput per lead partner.

Settings → Diligence has three controls: **Schemas** (the seven YAML editors), **Style Anchors** (reference memo library), and **Defaults** (per-deal and monthly token caps with current-month usage bar, plus per-stage AI provider overrides — e.g. cheap model for ingest, stronger model for draft).

## Settings

Settings is where the platform is configured. Most settings are admin-only, but all users can update their display name and enable two-factor authentication.

For admins, Settings covers: AI provider keys and model selection (Anthropic, OpenAI, and/or OpenRouter), fund currency, feature visibility (control which features are visible to everyone, admin-only, hidden, or off), inbound email setup (Postmark or Mailgun), outbound email providers (Gmail, Resend, Postmark, or Mailgun), file storage connections (Google Drive or Dropbox), the AI summary prompt, email templates for reporting asks, analytics (Fathom, Google Analytics, and custom scripts), authorized senders, team members and roles, and the signup allow-list. The **Deals** group configures the inbound-pitch screening flow: investment thesis, screening prompt, intake toggle, public submission URL, known referrers, routing confidence threshold, and optional per-stage routing-model override. The **Diligence** group has three sub-pages: Schemas (the seven YAML editors with version history), Style Anchors (reference memo library with text extraction), and Defaults (per-deal and monthly token caps, per-stage AI provider overrides). The current app version is shown at the bottom of Settings, with a link to the Updates page when a newer version is available.

![Settings](public/screenshots/settings.png)
