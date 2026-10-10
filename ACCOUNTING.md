# Portfolio, by Hemrock — Fund accounting

- Project overview at [README](./README.md)
- Detailed feature descriptions at [FEATURES](./FEATURES.md)
- Technical deployment details at [DOCS](./DOCS.md)

Every entity keeps a double-entry ledger, **always**. Its chart of accounts exists from the day the
entity is created, and recording an investment, an exit, a mark, a conversion or a capital call posts
its entry — so the books are complete whether or not anyone opens the accounting pages. The
**Accounting** feature (Settings → Feature visibility, part of Fund Operations) decides whether those
pages are shown, the way Investments and LP capital tracking do; it never decides whether books are
kept. This covers both halves: bringing an entity's history onto the books, and how every entry is
booked once they're running.

In this system a **vehicle is a `portfolio_group`**: `fund_id` is the company/installation, and each
SPV / Fund I / Fund II is a `portfolio_group` under it, with its **own separate books** (chart,
ledger, capital accounts, bank feed, periods).

**Contents**

- [Setting up a vehicle](#setting-up-a-vehicle) — bringing history onto the books, by scenario
- [Going live & keeping the books](#going-live--keeping-the-books)
- [Management companies](#management-companies) — the firm's own books, and intercompany
- [Double-entry reference](#double-entry-reference) — how each entry type is booked
- [The capital-account roll-forward](#the-capital-account-roll-forward)
- [Verifying the books](#verifying-the-books) — the checks that should always hold
- [Authoring in text](#authoring-in-text)
- [Forecasts and budgets](#forecasts-and-budgets) — how a plan is stored, and why it never touches the ledger
- [Agents](#agents)

---

# Setting up a vehicle

There is no activation and no setup step: the books exist already. What varies is how much history
an entity has to bring onto them.

## Before you start

1. **Show the pages.** Settings → *Feature visibility* → **Accounting** (or *Turn on Fund
   Operations*, which turns on its features for admins). Hiding them later keeps the books running.
2. **Partners and commitments.** The allocation basis comes from each partner's commitment (Admin →
   Allocation terms, or the LP data the entity was built from). A fund with no partner commitments
   cannot allocate, so posting an income or expense entry is refused until it has them.
3. **Investment history already in the tracker.** Open the entity's status page (**Entities → the
   entity → Admin**): it says how many investment items have not reached the ledger. *Put them on the
   ledger* adopts any matching entries already there and posts the missing ones on their own dates; it
   is safe to run again. The entity index can do it for every entity at once.

Every page scopes to one entity — chosen with the switcher in the header.

---

## Scenario A — an existing entity already on the platform (e.g. the SPV)

The entity's LPs, commitments, and prior figures are already in the platform. So is its chart of
accounts: an entity gets the chart for its kind when it is created, and one created before that gets
it the first time its books are opened. You choose how much history to bring in. (A QuickBooks
general ledger can be imported instead: **Migrate from QuickBooks** on the status page.)

### A1. Full history (reconstruct from inception) — recommended for the SPV

Best when volume is low and you want a complete, auditable trail.

1. **Bank transactions** → paste or **Upload CSV/XLS** of the bank history from inception. Rows are
   deduped; a row matching an entry already posted (an investment, a capital call) is linked to it,
   and each other row drafts a balanced entry.
2. **Categorize with AI** to classify the fuzzy rows against the chart.
3. For each inflow that's a capital call, **Book as call** (allocates per LP by commitment) or
   **Match call** if you already recorded it. Post the drafts.
4. **Record the investment purchase on the company** (its Investments panel → add a transaction).
   The transaction derives its journal entry and posts it (`Dr 1100 / Cr 1000`); the bank row for
   the wire links to that entry rather than drafting a second one. An entry written by hand or
   imported on an investment account is **adopted**: it creates the matching investment
   transaction, so the tracker and the books stay one record.
5. Record each periodic mark as a **valuation update on the company** (a quoted holding can book
   its price feed's quote; a fund holding books its manager's NAV statement). The delta against the
   ledger's carrying value is booked as unrealized, and the close allocates it per LP and moves NAV.
6. **Reconcile** → *Load from LP snapshot* to prefill the answer-key from `lp_investments`, then
   reconcile the ledger capital accounts against it. Use the statements **As of** control to tie out
   at each historical date.
7. **Close & lock** each completed period (see [Going live](#going-live--keeping-the-books)).

### A2. Cutover opening balance

Best for other vehicles where reconstructing history isn't worth it.

1. Open the entity's **Opening balances** page → pick the cutover date → enter each LP's capital
   balance from their latest statement. It books one opening entry as of that date,
   `Dr Cash / Cr each LP's capital`.
2. **Record the investment purchase on the company**, as in A1, so cash moves into the investment
   (`Dr 1100 / Cr 1000`), leaving ending cash = paid-in − cost.
3. Run forward from the cutover: book new calls/distributions/fees/marks as they happen.

---

## Scenario B — a brand-new fund/entity in the same company

Greenfield: no history to reconstruct — you're the book of record from first close.

1. **Add the entity** (Entities → *Add vehicle*), then its investors and their commitments in the
   **LPs** section (or import them).
   Set the vehicle's economics on its admin status page (**Entities → the vehicle → Admin**, `/funds/[id]/status`): vintage on the vehicle record, plus carry terms (rate, preferred return, catch-up, and the receiving GP entity) and allocation terms (each partner's commitment, including the GP's, and who bears fees, expenses, and carry).
2. The vehicle's chart of accounts is seeded when the vehicle is created; there is no setup step.
3. Book from **first close forward**:
   - **Capital call**: issue it from **Capital accounts**, then match the wire from the bank feed
     — it ends as `Dr Cash / Cr each LP capital`.
   - **Investment purchase**: record it on the company; its entry (`Dr 1100 / Cr 1000`) posts with it.
   - **Management fee / expenses / gains**: **Journal → New entry** (Management fee, Partnership
     expense, Realized gain) as they occur — each shows the entry before it is written.
   - **Valuation update** on each holding at each reporting date.
4. Reconcile cash against the bank feed; close & lock each period.

No historical import — you simply start recording.

---

## Scenario C — a brand-new company / fresh install

1. Deploy against a fresh Supabase project and run all migrations.
2. Complete onboarding to create the fund and the first admin user (`fund_members`).
3. Add the first entity and its investors (Scenario B, step 1), then follow Scenario A or B per entity.

Everything is per-vehicle from there, so the same company can run an SPV and a fund side by side.

---

# Going live & keeping the books

- **Allocation happens when an entry posts.** Posting an income or expense entry writes its partner
  allocation at once — a separate entry dated the same day, memo ending "— partner allocation", from
  3200 Undistributed earnings to each partner's capital by the basis in force on that date. Unposting
  or voiding the source takes its allocation with it. If an allocation cannot be made (no partner
  with a commitment, say), the entry is not posted.
- **Close:** the **Close** page reviews and locks a month. It catches up any P&L that was never
  allocated (older books), trues up accrued carried interest to that month's NAV, accrues note
  interest, and records its review: trial balance, no drafts, bank activity recorded, **bank
  reconciliation** (ledger cash on 1000 against the imported bank feed, both as of the month end),
  partner allocations complete, valuation and cutoff. Drafts and suggested recurring entries inside
  the month can be posted from the Close page itself. Opening a closed month lists every allocation
  in it — made on posting, or by the close.
- **Correct a posted entry:** open it in the Journal and **Reverse** it — a dated contra-entry
  lands as a draft, the original stays posted, and the pair nets to zero from that date. Void is
  for drafts and same-day slips; a reversal is what a preparer expects to see. An accrual can be
  given a *Reverses on* date when it is entered, and the reversal draft is created for you.
- **Lock the period:** **Close** → *Close & lock* the date range. This snapshots the whole ledger
  as plain-text double-entry (the audit record) and **blocks any new posting dated inside the range**
  until you reopen it.
- **Amend a closed period:** Close → *Reopen*, post the fix, close & lock again.
- **Statements at any date:** the **Financial statements** page has an *As of* control so every
  statement can be viewed at a chosen date.

---

# Individuals

An **individual** (`kind = 'individual'`) is a person investing for their own account, or the
single-member LLC they do it through — an angel. For tax the LLC is disregarded, so the two keep
the same books.

The investment side of those books is a fund's, code for code: per-company cost and unrealized
accounts under 1100/1200, marks, the schedule of investments, realized gains by lot. What differs
is the equity and the expenses:

- **Equity is one owner.** 3000 Owner's capital and 3100 Owner's draws. No GP, no LPs, no
  commitments, no allocation terms. The pages that exist for partners — Capital accounts,
  Portfolio construction, the fund-of-funds pages — are hidden.
- **Expenses are the preparer's lines.** Investment expenses, professional fees, software,
  travel, home office, dues, education, interest, other — the categories a personal return asks
  about, so the year-end export keys onto the schedule instead of being reclassified by hand.
- **The close rolls into owner's capital.** See below. The Tax page's *Realized gains by lot* is
  the Schedule D and Form 8949 input; the tax package carries it as a CSV.

## The owner's-equity close

A fund's close allocates each P&L category across the partners by their basis. A management
company and an individual have no partners: net income goes to **one equity account** — members'
capital for a manco, owner's capital for an individual (both carry the subtype `members_capital`,
which is how the close finds them) — and there is nothing to split. The close still posts one
entry per category through the bridge (3200), tagged `close:<period>`, so reopening voids exactly
those entries and the statement of operations keeps its lines. Carry, note interest on a fund's
positions and associate economics do not apply and are not run. `lib/accounting/close-owner.ts`
builds the entries; `closesToOwnerEquity` in `lib/vehicle-kinds.ts` decides which kinds take it.

---

# Management companies

A **management company** is the firm's own operating entity: it employs the team, collects the
management fee and pays the rent. It is not an investment vehicle, and the difference runs deeper
than a label — it has no commitments, no NAV, no TVPI and no partners in the LP sense, so almost
everything on this page above does not apply to it.

It is therefore a vehicle **kind** of its own (`manco`), with its own chart, its own lead page —
cash, the quarterly fee cycle, where the money goes, and what the funds owe it, in place of the
performance page a fund gets — and, this being the part worth reading carefully, **its own access
grant** (switched on in Settings → *Feature visibility*).

It is not a section of its own. It was, while its pages were a parallel copy of the fund ones; a
manco keeps double-entry books like any other entity, so those are the same pages now and it is a
row in **Entities** addressed the same way (`/funds/<id>/journal`). The grant did not move with the
URL, because the grant never depended on it — see below.

## Why a separate grant

Everywhere else in this system, related things share a grant when one is derivable from the other:
a K-1 is derived from the capital accounts, which ARE the ledger, so `tax_reporting` sits inside
`accounting` rather than pretending to a boundary that does not exist.

A management company is the opposite case. Its ledger carries **salaries, bonuses and partner
draws**, and none of that appears anywhere in a fund's trial balance — the fund sees one number,
the management fee it pays. The boundary is real, so it is enforced rather than described:

- `management_company` is a domain of its own, seeded at **`none`** for every existing member. An
  admin grants it deliberately, per person. (Every other domain was seeded at `write`, because it
  was describing behaviour that already existed. This one has none to preserve.)
- A manco is **excluded from `listVehicles`**, which is what `resolveVehicle` resolves against — so
  every accounting route, every MCP tool, the Analyst's context and the pending-action builders
  refuse it by default, without having been changed. Two callers opt in
  (`lib/accounting/http-vehicle.ts`) and both check the grant immediately.
- Reaching a manco's ledger through the shared accounting pages needs **both** grants:
  `management_company` because the books are the firm's, and `accounting` because those pages call
  `/api/accounting/*`. A manco-only bookkeeper gets the entity list and its lead page — the
  dashboard, the chart, the statements and intercompany, all `/api/manco/*` — and needs fund
  accounting to open the ledger pages.
- Because every entity now shares one set of pages, "which grant does this page need" is no longer
  answerable from the URL. It is answered from the **entity**: `requireVehicleAccess`
  (`app/(app)/funds/guard.ts`) resolves the vehicle every entity page has to resolve anyway, and
  demands `management_company` when that vehicle is a manco. It is the page twin of
  `assertVehicleDomain`, and it is deliberately the same shape — the check lives inside the call a
  page cannot skip, so a new page under `/funds/[id]` cannot forget it.

`tests/manco-vehicle-domain.test.ts` pins all of it.

**Entities, not only domains.** The same guard also checks the member can see *that entity* (Settings →
Team → Access, "Whose data they see"). A member granted Fund I but not the management company gets
"not found" for the manco's pages and 403 "You don't have access to that entity." from its APIs —
whatever their accounting or management-company grant says. Grants answer *what*; entities answer
*whose*; both must allow it.

## Setting one up

1. **Settings → Feature visibility → Management company** (ships `off`; *Turn on Fund Operations*
   sets it to admins). Members need the separate **Management company** grant (Settings → Team → Access).
2. **Entities → Admin → Add vehicle**, type *Management company*. It is the same button that adds
   a fund; the type decides the chart, the pages and the grant.
3. The chart below is seeded when it is created; there is no setup step, no cutover / full-history
   choice and no capital accounts to create — those are about LPs.
4. Import the QuickBooks general ledger from the entity's page if there is history to bring in. The
   mapping proposer knows the manco vocabulary — payroll, benefits, occupancy, technology — so most
   accounts arrive already matched.

## Chart of accounts (the management-company seed)

| Code | Account | Type | Normal side |
|---|---|---|---|
| 1000 / 1050 | Cash — operating / reserve | asset | debit |
| 1100 | Accounts receivable | asset | debit |
| 1300 | Prepaid expenses | asset | debit |
| 1350 | Security deposits | asset | debit |
| 1400 / 1450 | Furniture and equipment / accumulated depreciation | asset | debit |
| **1900** | **Due from affiliates** | asset | debit |
| 1900-`<id>` | Due from `<vehicle>` (one per counterparty) | asset | debit |
| 2000 / 2100 | Accounts payable / accrued expenses | liability | credit |
| 2150 | Accrued compensation | liability | credit |
| 2200 | Payroll liabilities | liability | credit |
| 2400 | Deferred management fee revenue | liability | credit |
| 2500 | Note payable | liability | credit |
| **2900** | **Due to affiliates** | liability | credit |
| 2900-`<id>` | Due to `<vehicle>` (one per counterparty) | liability | credit |
| 3000 / 3100 | Members' capital / member distributions | equity | credit |
| 3200 | **Undistributed earnings (bridge)** | equity | credit |
| 4000 | Management fee income | income | credit |
| 4100 | Expense reimbursement income | income | credit |
| 4200 / 4900 | Interest income / other income | income | credit |
| 5000 / 5010 / 5020 / 5030 | Salaries / payroll taxes / benefits / bonus | expense | debit |
| 5100 | Rent and occupancy | expense | debit |
| 5200 / 5210 / 5220 | Legal / audit and tax / fund administration | expense | debit |
| 5300 / 5400 / 5500 | Technology / travel / marketing | expense | debit |
| 5600 / 5700 | Insurance / office and general | expense | debit |
| 5800 / 5900 | Depreciation / interest expense | expense | debit |

Three of these are decisions rather than lines, and they are why a fund chart cannot be reused:

- **Compensation is four accounts, not one.** "What does a head cost us" is 5000+5010+5020; "what
  did we pay out on last year's performance" is 5030. Rolled together, neither question can be
  answered again from the ledger.
- **2400 exists because the fee is billed before it is earned.** A quarterly fee charged in advance
  lands on 1 January for a quarter that has not happened. Recognising all of it in January
  overstates Q1 revenue by two thirds; 2400 holds the unearned part and releases it monthly.
- **1900 and 2900 never net.** What the funds owe the firm and what the firm owes them are balances
  with different counterparties settling on different dates, and each has to be confirmed against
  another entity's books. A net figure matches neither side.

3200 is the same bridge the fund chart uses, and a manco needs it for the same reason: the period
close flattens the P&L into it and rolls the result into members' capital.

## Intercompany transactions

A charge between two vehicles of the same firm is **one economic fact and two ledgers**. Entered as
two ordinary journal entries, nothing knows they are the same charge: the firm's receivable and the
fund's payable are independent numbers that agree only while both were typed correctly, and when
they stop agreeing there is no way to tell which one moved.

So *Record a charge* on the management company's page writes **both sides in one action**, each
entry tagged `source_ref = intercompany:<id>`, with the pair recorded in
`intercompany_transactions`.

**Accrual** (management fee, expense reimbursement, allocated cost, other):

```
payee (the firm)   Dr 1900-<payer>   Cr 4000 Management fee income
payer (the fund)   Dr 5000 Management fee   Cr 2900-<payee>
```

**Settlement**, when the cash actually moves — a separate event, often a separate quarter:

```
payee   Dr 1000 Cash        Cr 1900-<payer>
payer   Dr 2900-<payee>     Cr 1000 Cash
```

**Advances and repayments** move cash as they are recorded, so they have one event and no
settlement of their own — an advance is cleared by recording a repayment, because that is what
happened.

Two things follow from the design and are worth knowing:

- The **balance** shown per counterparty is read off the ledger (the 1900-`<id>` / 2900-`<id>`
  accounts), never summed from the register. A manual correcting entry — how half of all
  intercompany disputes are actually resolved — is reflected without anyone amending a row.
- Both sides post **or neither does**. If the payer's entry fails (a closed period on the fund's
  books is the realistic case), the payee's entry is voided and the charge is removed.

Each side's accounts are resolved from **its own chart by subtype**, so a fund, a GP entity and
another management company can all be the counterparty. Where a side has no defensible account for
the charge, the post is refused with a message naming what is missing — a charge in the wrong income
account still balances, so nothing downstream would ever flag it.

Neither `capital_contribution` nor equity funding is an intercompany charge: funding an affiliate is
equity, not a balance one side can demand back, and it is booked as an ordinary entry against
members' capital on both sets of books.

## What a management company does NOT get

No capital accounts, no capital calls, no schedule of investments, no allocation terms, no
waterfall, no LP statements, no K-1s. It has no limited partners. Its period close rolls the
operating result into members' capital and nothing else.

It is also excluded from the `/funds` overview, the fund switcher, and per-vehicle performance
roll-ups. Every column there would be a dash.

---

# Double-entry reference

How every entry type is booked, in both T-account form and the plain-text double-entry format you
author in. Use this to write entries on the journal's **Plain text** tab and to verify the books are set up
correctly. Everything here matches what the entry builders in `lib/accounting/entries.ts` produce.

## The two rules that make it all work

1. **Signed amounts, debits positive.** Every posting is a signed number: a **debit is positive**,
   a **credit is negative**.
2. **Every entry sums to zero** (per currency). If it doesn't balance, it can't be posted.

By convention, a posting's amount is simply the signed change to that account, so the plain text and
the ledger agree with no sign flipping.

## Chart of accounts (the default seed)

| Code | Account | Type | Normal side |
|---|---|---|---|
| 1000 | Cash | asset | debit |
| 1100 | Investments at cost | asset | debit |
| 1200 | Unrealized appreciation/(depreciation) | asset | debit |
| 1300 | Due from LPs | asset | debit |
| 2000 | Accrued expenses | liability | credit |
| 2100 | Due to GP | liability | credit |
| 3000 | Partners' capital — GP | equity | credit |
| 3100 | Partners' capital — LP (unallocated) | equity | credit |
| 3200 | **Undistributed earnings (bridge)** | equity | credit |
| 3100-`<id>` | Partners' capital — `<LP name>` (one per LP) | equity | credit |
| 4000 | Realized gains | income | credit |
| 4100 | Interest and dividend income | income | credit |
| 4200 | Change in unrealized appreciation | income | credit |
| 5000 | Management fee | expense | debit |
| 5100 | Partnership expenses | expense | debit |
| 5200 | Organizational expenses | expense | debit |

Per-LP capital accounts (`3100-<id>`) are created automatically the first time an allocation touches
that LP. In text they read `Equity:Partners-Capital-<Name>:3100-<id>`.

## Why the bridge (3200) exists

Fees, expenses, and income need to be in **two** places: the **income statement** (as expense/income)
*and* each LP's **capital account** (reducing/increasing it). The entry you book — by hand, from the
journal's New entry menu, or from the bank feed — posts the **P&L side only** (`Dr 5000 / Cr 2100`
for a fee). The **period close** then posts the capital side for every category in the month: it
debits or credits each partner's capital account for their share and parks the offset in
**Undistributed earnings (3200)**. During a period the income statement is right and the capital
accounts lag by the unclosed month; at close they catch up, and the balance sheet's *unallocated
earnings* line goes to zero. The T-accounts for entries 4–7 below show the whole economic picture,
the P&L line and the capital lines together; the capital lines are the close's, not the entry's.

## Entry types

Each type below shows the debits/credits, the `source` (which drives the capital-account roll-forward
line), and the text you'd author. `Dr` = positive, `Cr` = negative.

### 1. Opening balances (cutover) — `source: opening_balance`
Take over at a date with each LP's capital from their last statement. **Capital in nets against
cash** — the opening credits each LP's capital and debits Cash; the investment purchase is booked
separately (entry 3), which moves that cash into the investment. Roll-forward line: **beginning**.

| Account | Dr / Cr |
|---|---|
| 1000 Cash | Dr total |
| 3100-`<id>` each LP capital | Cr their opening balance |

```text
2021-06-30 * "Opening capital (cutover)"
  source: "opening_balance"
  Assets:Cash:1000                         3000000.00 USD
  Equity:Partners-Capital-John-Smith:3100-aaaa    -1800000.00 USD
  Equity:Partners-Capital-Acme-LLC:3100-bbbb      -1200000.00 USD
```
*After this, book the investment purchase (entry 3) to move cash into the investment, so ending
cash = paid-in − investment cost.*

### 2. Capital call — `source: capital_call`
Cash comes in; each LP's capital increases pro-rata by commitment. Line: **contributions**.

| Account | Dr / Cr |
|---|---|
| 1000 Cash | Dr total |
| 3100-`<id>` each LP capital | Cr their share |

```text
2021-07-01 * "Capital call — Q3"
  source: "capital_call"
  Assets:Cash:1000                         5000000.00 USD
  Equity:Partners-Capital-John-Smith:3100-aaaa   -3000000.00 USD
  Equity:Partners-Capital-Acme-LLC:3100-bbbb     -2000000.00 USD
```

### 3. Investment purchase — `source: manual` (plain two-line)
Buy the SPV's investment. No allocation — just moves cash into the asset. There is no dedicated
action; book it here in text (or via a bank outflow re-categorized to 1100).

| Account | Dr / Cr |
|---|---|
| 1100 Investments at cost | Dr cost |
| 1000 Cash | Cr cost |

```text
2021-07-15 * "Investment — purchase"
  Assets:Investments-At-Cost:1100          4800000.00 USD
  Assets:Cash:1000                        -4800000.00 USD
```

### 4. Management fee — `source: management_fee` (compound, via bridge)
Expense hits the income statement; each LP's capital is reduced. Line: **managementFees**.

| Account | Dr / Cr |
|---|---|
| 5000 Management fee (expense) | Dr total |
| 2100 Due to GP (liability) | Cr total |
| 3100-`<id>` each LP capital | Dr their fee |
| 3200 Undistributed earnings | Cr total |

```text
2021-09-30 * "Management fee — Q3"
  source: "management_fee"
  Expenses:Management-Fee:5000             50000.00 USD
  Liabilities:Due-To-Gp:2100             -50000.00 USD
  Equity:Partners-Capital-John-Smith:3100-aaaa   30000.00 USD
  Equity:Partners-Capital-Acme-LLC:3100-bbbb     20000.00 USD
  Equity:Undistributed-Earnings:3200    -50000.00 USD
```
Paying the fee later is a separate plain entry: `Dr 2100 Due to GP / Cr 1000 Cash`.

### 5. Partnership expense — `source: partnership_expense` (compound, via bridge)
Same shape as the fee, but paid from cash and allocated pro-rata. Line: **expenses**.

| Account | Dr / Cr |
|---|---|
| 5100 Partnership expenses | Dr total |
| 1000 Cash | Cr total |
| 3100-`<id>` each LP capital | Dr their share |
| 3200 Undistributed earnings | Cr total |

```text
2021-10-05 * "Audit fee"
  source: "partnership_expense"
  Expenses:Partnership-Expenses:5100      12000.00 USD
  Assets:Cash:1000                       -12000.00 USD
  Equity:Partners-Capital-John-Smith:3100-aaaa    7200.00 USD
  Equity:Partners-Capital-Acme-LLC:3100-bbbb      4800.00 USD
  Equity:Undistributed-Earnings:3200     -12000.00 USD
```

### 6. Realized gain / income — `source: realized_gain` (compound, via bridge)
Cash/income in; each LP's capital increases. Line: **gains**.

| Account | Dr / Cr |
|---|---|
| 1000 Cash | Dr total |
| 4000 Realized gains (income) | Cr total |
| 3200 Undistributed earnings | Dr total |
| 3100-`<id>` each LP capital | Cr their share |

```text
2023-03-01 * "Partial realization"
  source: "realized_gain"
  Assets:Cash:1000                         500000.00 USD
  Income:Realized-Gains:4000              -500000.00 USD
  Equity:Undistributed-Earnings:3200       500000.00 USD
  Equity:Partners-Capital-John-Smith:3100-aaaa   -300000.00 USD
  Equity:Partners-Capital-Acme-LLC:3100-bbbb     -200000.00 USD
```

### 7. Revaluation (unrealized mark) — `source: valuation` (compound, via bridge)
Mark the investment to a new fair value by recording a valuation update on the company (or booking
a quoted price or a manager's NAV). The derived entry books the **delta** vs the ledger's current
carrying value. Line: **gains**. (A mark-down flips every sign.)

| Account | Dr / Cr |
|---|---|
| 1200 Unrealized appreciation (asset) | Dr delta |
| 4200 Change in unrealized (income) | Cr delta |
| 3200 Undistributed earnings | Dr delta |
| 3100-`<id>` each LP capital | Cr their share |

```text
2022-12-31 * "Year-end mark"
  source: "valuation"
  Assets:Unrealized-Appreciation:1200      1000000.00 USD
  Income:Change-In-Unrealized-Appreciation:4200  -1000000.00 USD
  Equity:Undistributed-Earnings:3200       1000000.00 USD
  Equity:Partners-Capital-John-Smith:3100-aaaa   -600000.00 USD
  Equity:Partners-Capital-Acme-LLC:3100-bbbb     -400000.00 USD
```

### 8. Distribution — `source: distribution`
Cash out to LPs; each LP's capital decreases. Line: **distributions**.

| Account | Dr / Cr |
|---|---|
| 3100-`<id>` each LP capital | Dr their distribution |
| 1000 Cash | Cr total |

Declaring from the Capital accounts page posts the same debit against **2300 Distributions payable** instead of cash; the wire that follows settles the payable (`source: distribution_settlement`), which is what lets a bank row match back to the declaration. A fund-wide declaration is split **through the vehicle's waterfall** (`lib/accounting/distribution-waterfall.ts`): prior distributions are replayed through the tiers to find where return of capital, the preferred return and the GP's catch-up stand, and only then is this one split. The GP's take posts as a **second entry** with `source: carry_distribution` — Dr the recipient's capital, Cr 2300 — which the roll-forward files on the **carried interest** line against the accrual, so a paid carry reads as carry paid rather than as a return of the GP's own capital. Both entry ids sit on the `distributions` register row with the tier amounts and the split method.

```text
2023-03-15 * "Distribution"
  source: "distribution"
  Equity:Partners-Capital-John-Smith:3100-aaaa    300000.00 USD
  Equity:Partners-Capital-Acme-LLC:3100-bbbb      200000.00 USD
  Assets:Cash:1000                        -500000.00 USD
```

### 9. Carried interest — `source: carried_interest`
Move profit from LPs to the GP. Line: **other** (on the LP roll-forward).

| Account | Dr / Cr |
|---|---|
| 3100-`<id>` each LP capital | Dr their carry |
| 3000 Partners' capital — GP | Cr total |

```text
2023-03-15 * "Carried interest"
  source: "carried_interest"
  Equity:Partners-Capital-John-Smith:3100-aaaa    60000.00 USD
  Equity:Partners-Capital-Acme-LLC:3100-bbbb      40000.00 USD
  Equity:Partners-Capital-Gp:3000        -100000.00 USD
```

### 10. Period close — `source: period_close`
Zero every income/expense account into the bridge. No LP postings — capital is already current.

| Account | Dr / Cr |
|---|---|
| each income/expense account | the negation of its balance |
| 3200 Undistributed earnings | the net |

```text
2022-12-31 * "Period close"
  source: "period_close"
  Income:Realized-Gains:4000               500000.00 USD   ; was a -500000 credit balance
  Expenses:Management-Fee:5000            -200000.00 USD   ; was a +200000 debit balance
  Equity:Undistributed-Earnings:3200     -300000.00 USD
```

### 11. Conversion (SAFE / note → equity) — `source: investment` (posted from the tracker)
A SAFE or convertible note converting into a priced round (e.g. Series A). In the tracker it is
recorded as the **priced-round investment it becomes**, linked to the instrument it converted from
(`converts_from_txn_id`); there is no separate transaction type. Saving it **posts** the entry
below — like every entry derived from an investment transaction. (A draft is left only if the
partner allocation cannot be made; it says why.)

A conversion is a **pure roll-over — it carries no cash of its own**. New money written at the same
round is recorded as a *separate* `investment` row (same round name), so it stays a distinct line.

The source instrument's **principal is already in `1100`** from its own purchase date and is never
re-posted. The conversion books only what changes **on the conversion date**, as one entry with up
to three independently-balanced pieces:

| Account | Dr / Cr | When present |
|---|---|---|
| 1100-`<co>` Investments at cost | Dr interest | a note with accrued interest |
| 1150-`<co>` Accrued interest | Cr interest | a note with accrued interest |
| 1200-`<co>` Unrealized appreciation | Dr step-up | round price ≠ carried basis |
| 4200 Change in unrealized (income) | Cr step-up | — |

where **carried basis** = source principal + converted interest, and **step-up** =
(shares × round price) − carried basis (negative on a down round → an unrealized loss). With no
round price the position is held at carried cost and no step-up is booked. (A pure SAFE conversion
with no interest books *only* the step-up.)

```text
2022-06-01 * "Conversion to equity — Acme (Series A)"   ; $100k SAFE → 50,000 @ $3.00 = $150k
  source: "investment"
  Assets:Unrealized-Appreciation:1200-acme        50000.00 USD   ; the +$50k step-up
  Income:Change-In-Unrealized-Appreciation:4200  -50000.00 USD
  ; a pure conversion moves no cash and does not touch 1100 — the principal is already there
```

**How it reaches the statements** (all derived from the posted ledger):
- **Balance sheet** — the position's carrying value (`1100 + 1200`) becomes shares × round price;
  `1150` accrued interest clears into basis. (Any new check at the round is its own investment row.)
- **Statement of operations** — the step-up is **change in unrealized appreciation (`4200`)**, in the
  period of the conversion date, not the SAFE's original date. Interest that accrued *before*
  conversion already hit `4100` over prior closes, so it is not re-recognized here.
- **Cash flows** — a conversion moves no cash, so it appears under **supplemental non-cash
  investing & financing** (ASC 230), never as an outflow. (A new check at the round is a separate
  investment row and shows as its own operating outflow.)
- **Schedule of investments** — cost = carried basis, fair value = shares × round price, and the
  ledger ties to the tracker because the step-up actually posted to `1200`.
- **Changes in partners' capital** — the step-up allocates to LPs (line **gains**) at the next
  **period close**; until then it sits in unallocated earnings.

---

# The capital-account roll-forward

Each LP's statement is built from the postings to their capital account, bucketed by the entry's
`source`:

```
  ending = beginning
         + contributions        (capital_call)
         - distributions        (distribution)
         - management fees       (management_fee)
         - partnership expenses  (partnership_expense)
         + gains                 (realized_gain, valuation)
         + other                 (carried_interest, anything else)
```

`ending` is computed as the **raw sum of that LP's capital postings**, so it always ties to the
ledger regardless of how lines are labeled. **Fund NAV = sum of every LP's ending capital.**

---

# Verifying the books

Checks that should always hold — use these to confirm a new setup and to sanity-check a close:

- **Every entry balances.** The journal (the entry form and the Plain text tab) rejects unbalanced entries; the trial
  balance (Financial statements) shows equal total debits and credits.
- **Balance sheet identity.** Assets = Liabilities + Partners' capital. On the Financial statements
  page the balance-sheet `check` is 0 once the period is closed (before close, the residual equals
  net income not yet closed to capital).
- **NAV ties.** Fund NAV on the Capital accounts page = sum of the LPs' ending capital = the equity
  total on the balance sheet.
- **Bridge nets to zero after close.** Account 3200 Undistributed earnings should be 0 once you've
  run the period close; income/expense accounts should be 0 too.
- **Reconcile against the LP snapshot.** On Reconciliation → *Load from LP snapshot*, contributions
  should match paid-in and distributions should match the LP data already in the platform.
- **Bank reconciliation.** Ledger cash (1000) equals the bank feed's ending balance once every
  transaction is matched.
- **Per-vehicle isolation.** Each `portfolio_group` has its own chart, entries, and capital accounts;
  switching the vehicle selector should change every figure.

---

# Authoring in text — quick rules

- A transaction is `DATE FLAG "narration"` then indented postings. `*` posts; `!` saves a draft.
- Reference accounts by full name (`Assets:Cash:1000`) or just the code is matched from the last
  component. Unknown accounts are reported, never guessed.
- One posting per entry may **omit its amount** — it's inferred so the entry balances.
- `source: "<type>"` metadata sets the roll-forward line; omit it for a plain `manual` entry.
- Lines starting with `;` are comments; `open`/`close`/other directives are ignored.

---

# Forecasts and budgets

Budgets and rolling forecasts (FEATURES → Forecast) are **stored the way the books are** — dated,
balanced entries — but in their own tables (`forecast_entries` / `forecast_postings`), never in
`journal_*`, and never with a `book`. Nothing a plan does can change the ledger, a closed period, a
capital account or a statement.

- **Inputs** are one rule per income/expense account (`forecast_rules`) and month overrides
  (`forecast_overrides`). **Output** is compiled entries: a plan is rebuilt whole on every save, in one
  transaction guarded by the plan's revision (a stale save is refused, not merged).
- **Cash timing by double entry.** Paid in the month: Dr expense / Cr cash. Paid later: Dr expense /
  Cr accrued (2000/2100), then Dr accrued / Cr cash. Paid earlier: Dr prepaid / Cr cash, then
  Dr expense / Cr prepaid. Revenue mirrors it through receivable and deferred revenue (a management
  company's 1100 and 2400). A chart without the counter-account falls back to same-month cash, and
  says so.
- **Opening balances.** Payables and receivables open in the actuals when a plan starts settle in its
  first month (configurable); prepaid and deferred balances are left to the rules that release them.
- **Actuals** are only ever posted, actual-book entries. A rolling forecast joins them at an explicit
  cutoff — the last closed month by default — and every month after an unclosed one is labelled so.
- **Versions** freeze the compiled entries with the rules that made them; an approved budget is never
  overwritten, and a later revision is a new version.
- **Fund flows.** With construction included, a fund plan carries investments (Dr investments at
  cost / Cr cash), exits (Dr cash / Cr cost / Cr realized gain), capital calls (Dr cash / Cr LP
  capital) and distributions (Dr LP capital / Cr cash). Fees and expenses come only from the rules on
  5000 and 5100, so construction's fees are never counted twice.

# Agents

Everything above is also available to agents over MCP/REST (switched on in Settings → *Agent access*;
each member's keys, MCP URL and the Claude and ChatGPT plugins are under Settings → *API and MCP* —
see DOCS → Connecting Claude, ChatGPT and other agents): import a
bank feed, categorize, book calls, record investment transactions (approved by a person before they
post), author entries as text, reconcile, close periods, and read, draft and publish budgets and forecasts
— each scoped to a vehicle via the `vehicle` argument, and only to entities the member can see.
