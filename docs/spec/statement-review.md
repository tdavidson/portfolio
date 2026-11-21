# Statement review

Status: stages 1 to 6 built (checks on structured input; comparisons with the books, bank and portfolio; management fee, carry and allocations against the terms; reading packages out of the administrator's documents with citations checked; finding statuses, drafted questions, sign-off and export; self-review of the app's own statements before they go out), plus per-vehicle review settings (instructions, watched accounts, known adjustments).

Stage 1 lives in `lib/statement-review` (package model, the foot, partners-sum, roll-forward,
continuity and completeness checks), `statement_reviews` (one row per run), the
`/api/accounting/statement-review` route, the Statement review page on each fund, and the
`statement_review_run` and `statement_review_findings` tools. A package comes from a saved
administrator pull, a partner capital schedule as CSV, or a package given whole (how the assistant
passes figures it read from a PDF before extraction exists). Until sign-off arrives in stage 5,
continuity compares with the latest earlier review rather than the last signed-off one, and the
materiality setting is carried forward from the vehicle's last run.

## Why

Portfolio started as a fund's own books. It is increasingly used next to a fund administrator: the
administrator keeps the books and issues the statements, and the CFO's job is to check them. Today the
app can show an administrator's figures (admin-reported vehicles) and diff stored snapshots against the
ledger, but it has no workflow for the question a CFO actually asks each quarter:

> The administrator sent this quarter's package. Is it right, and what do I need to ask them?

Statement review answers that question. One set of checks runs against two kinds of source:

- **An administrator's package**, for vehicles whose books someone else keeps. The checks compare the
  package with the app's shadow calculation and with the bank.
- **The app's own output**, for vehicles whose books the app keeps. The same checks run on the
  statements the app is about to send, as a review step before they go out.

Statement review never changes what an admin-reported vehicle shows. `lib/admin-reporting/figures.ts`
is deliberate that those figures are stated, not recalculated, and that stays true. Review runs beside
them and produces findings, not corrections.

## What exists

| Piece | Where | Use in review |
| --- | --- | --- |
| Admin figures pull and staging | `pull_admin_figures`, `stage_admin_figures`, `lib/admin-reporting/*` | Per-LP commitment, paid-in, distributions, NAV and carry as the administrator states them |
| Capital-account reconcile | `reconcile` (`lib/accounting/agent-tools-manifest.ts`) | Per-LP ledger vs admin ending balances, with a tolerance |
| Snapshot diff | `lp_reconcile_snapshot` | Stored snapshot vs live ledger as of the snapshot date |
| Bank reconciliation | `bank_reconciliation`, `lib/accounting/bank*.ts` | Cash per the books vs cash per the bank |
| Waterfall | `run_waterfall`, `docs/spec/waterfall-terms.md` | Shadow carry and distribution splits |
| Manager NAV statements | `record_nav_statement` | Holding-level NAV as reported vs what the ledger carries |
| OCR | `ocr_page`, `ocr_save_text` | Text out of a scanned PDF package |
| Staged changes | pending actions, `stage_run` | Anything review proposes to write goes through approval |

Most of the work is joining these into one flow, plus extraction and a findings model.

## The flow

1. **Load a package.** The CFO uploads the administrator's quarterly package (PDFs, spreadsheets or
   both) for one vehicle and one period, or points review at a period of the app's own books.
2. **Extract.** Pull the figures out of each document into a typed package (below). PDFs go through
   text extraction first and OCR where there's no text layer. Every extracted figure keeps a pointer to
   its document, page and label so a finding can cite it.
3. **Map.** Match the package's partners, holdings and accounts to the vehicle's own. Reuse the
   partner matching in `lib/admin-reporting` (external id, then name, then an explicit
   `lp_entity_id`). Unmatched rows become findings, not silent drops.
4. **Run the checks** (below) against the shadow calculation and the bank.
5. **Review findings.** Each finding has a severity, the stated figure, the expected figure, the
   difference and its sources. The CFO marks each one explained, asked, or accepted.
6. **Draft questions.** Open findings turn into a drafted list of questions for the administrator,
   grouped by document.
7. **Sign off.** When nothing is open, the CFO signs off the period. The sign-off records who, when,
   the package's file hashes and the check results, so the review is auditable later.

## The package model

One package per vehicle and period. Every field is optional, because packages differ; a check runs
only when its inputs are present and says so when it can't.

```ts
interface StatementPackage {
  vehicleId: string
  periodStart: string            // YYYY-MM-DD
  periodEnd: string              // YYYY-MM-DD
  source: 'administrator' | 'books'
  documents: PackageDocument[]   // file name, hash, kind, pages
  partners?: PartnerStatement[]  // one per capital account
  fund?: FundStatements          // balance sheet, operations, partners' capital, SOI totals
  holdings?: HoldingLine[]       // schedule of investments
  fees?: FeeLine[]               // management fee calculation
  carry?: CarryLine[]            // carried interest accrual or distribution
  cash?: CashLine[]              // ending balances by account
}

interface PartnerStatement {
  externalId: string
  name: string
  lpEntityId?: string
  commitment?: number
  beginning?: number
  contributions?: number
  distributions?: number
  allocations?: { income?: number; expenses?: number; managementFee?: number; realized?: number; unrealized?: number; carry?: number }
  ending?: number
  unfunded?: number
  cite: Record<string, Citation>  // field name → document, page, label
}
```

Example values in tests use invented funds and partners (`Example Fund I`, `Acme Partners LP`) and
round figures.

## The checks

Each check is a pure function from the package, the shadow calculation and the prior signed-off
package to a list of findings. They live in `lib/statement-review/checks/*.ts`, one file per check,
each with its own tests.

| Check | Rule | Needs |
| --- | --- | --- |
| Foots | Each statement's lines sum to its stated totals | Any statement with totals |
| Partners sum to fund | Sum of partner endings = fund partners' capital; same for contributions and distributions | Partners, fund |
| Roll-forward | Beginning + contributions − distributions ± allocations = ending, per partner and in total | Partners |
| Continuity | This period's beginning = last signed-off period's ending | Partners, prior package |
| Contributions and distributions | Each partner's flows match the app's capital calls and distributions for the period | Partners, ledger |
| Management fee | Fee per the LPA terms (basis, rate, offsets, step-downs) for the period | Fees, fund terms |
| Carry | Accrued or distributed carry matches `run_waterfall` on the same inputs | Carry, waterfall terms |
| Allocation | Income, expense and gain allocations follow the allocation basis the vehicle uses | Partners, allocation terms |
| Schedule of investments | Each holding's cost and fair value match the ledger and the valuation policy; new marks have support | Holdings |
| Cash | Ending cash by account matches the bank | Cash, bank feed |
| Completeness | Every partner and holding the app knows appears in the package, and nothing unknown does | Partners, holdings |

A finding:

```ts
interface Finding {
  check: string
  severity: 'error' | 'warning' | 'info'
  subject: { kind: 'partner' | 'holding' | 'fund' | 'account'; id?: string; label: string }
  stated?: number
  expected?: number
  difference?: number
  message: string                 // one sentence a CFO would write
  cites: Citation[]
  status: 'open' | 'explained' | 'asked' | 'accepted'
  note?: string
}
```

Materiality is a per-vehicle setting: an absolute amount and a share of fund NAV. Differences under it
are `info`; the default tolerance for rounding stays at `reconcile`'s 0.01.

## Shadow calculation

For vehicles the app keeps, the shadow is the books. For admin-reported vehicles it is built from what
the app already holds (commitments, calls, distributions, holdings and marks, fund and waterfall terms)
and is never shown as the vehicle's figures. Where the app lacks an input, the check that needs it says
so instead of guessing.

## Surfaces

- **App:** a Review tab on the vehicle, one row per period, opening to the findings list with each
  finding's citations shown beside it.
- **Agent:** read tools `statement_review_run` and `statement_review_findings`; write tools
  `statement_review_note` and `statement_review_sign_off`, both staged. Register them in the tool
  manifests like the admin-reporting tools.
- **Export:** the findings and the drafted questions as a PDF or a document the CFO can send.

## Access

Review shows per-LP capital, so it sits in the `lp_capital` domain, read for running and viewing,
write for notes and sign-off. New API routes go in `lib/access/route-domains.ts` and new server pages
in `lib/access/page-domains.ts`. New tables follow the migration template in `CLAUDE.md`, grants and
RLS included.

## Stages

1. **Checks on structured input.** The package model, the roll-forward, foot, partners-sum, continuity
   and completeness checks, fed from the existing admin-figures pull or a CSV. No extraction yet.
2. **Ledger comparisons.** Contributions and distributions, cash, schedule of investments.
3. **Terms comparisons.** Management fee, carry and allocation against the vehicle's terms.
4. **Extraction.** PDF and spreadsheet packages into the package model, with citations.
5. **Findings workflow.** Statuses, drafted questions, sign-off and export.
6. **Self-review.** Run the same checks on the app's own statements before they're issued.

Each stage ships on its own and is useful alone: stage 1 already catches the most common package
errors (a roll-forward that doesn't hold, a beginning balance that moved).

## Out of scope

- Changing an admin-reported vehicle's displayed figures. Review reports; it doesn't correct.
- Replacing the administrator. The app stays the independent check.
- Tax packages and K-1s. They can join later as their own checks.
