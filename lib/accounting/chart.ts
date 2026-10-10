// A default chart of accounts for a venture fund. Seeded per fund on first use;
// per-LP capital sub-accounts are created separately (they carry lp_entity_id).
// Codes follow the usual 1000/2000/3000/4000/5000 asset/liability/equity/income/
// expense blocks so statements group cleanly.

import type { AccountType } from './types'

export interface ChartAccountSeed {
  code: string
  name: string
  type: AccountType
  subtype?: string
}

/** The chart account that holds called-but-unfunded capital (a receivable).
 *  Lives here, not in capital-calls.ts, so capital-calls can depend on capital-source
 *  (which needs this code) without the two importing each other. */
export const RECEIVABLE_CODE = '1300'
/** Distributions declared and not yet paid — the outbound mirror of RECEIVABLE_CODE. */
export const DISTRIBUTION_PAYABLE_CODE = '2300'
/** Money a partner sent before it was called: a liability until a call applies it (lib/accounting/call-extras.ts). */
export const ADVANCE_CODE = '2350'

export const DEFAULT_CHART: ChartAccountSeed[] = [
  // Assets
  { code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  { code: '1100', name: 'Investments at cost', type: 'asset', subtype: 'investment' },
  { code: '1200', name: 'Unrealized appreciation/(depreciation)', type: 'asset', subtype: 'unrealized' },
  // A non-USD position moves for two unrelated reasons: the company got more (or less)
  // valuable, and the currency moved. Blending both into 1200/4200 makes "change in
  // unrealized appreciation" report investment performance and currency noise as one
  // number, and no LP can tell which they're looking at. ASC 830 wants them split, so
  // the rate move gets its own asset and its own income line. Carrying value of a
  // position is therefore 1100 + 1200 + 1250.
  { code: '1250', name: 'Foreign currency translation', type: 'asset', subtype: 'fx_translation' },
  { code: '1300', name: 'Due from LPs', type: 'asset', subtype: 'receivable' },
  // An exit's holdback. The tracker counts escrow in proceeds the moment the deal closes
  // (lib/investments.ts computeSummary), because economically the fund has earned it — but
  // the cash hasn't arrived. Booking only the cash received made the ledger's realized gain
  // differ from the tracker's by exactly the escrow, by construction, on every exit with a
  // holdback. Recognizing it as a RECEIVABLE at exit puts the two back in agreement, and the
  // receivable clears when the money actually lands.
  { code: '1350', name: 'Escrow receivable', type: 'asset', subtype: 'escrow_receivable' },
  // TAX-BOOK ASSETS. These carry postings in the `tax` book only — they are where a
  // book-to-tax adjustment puts the debit when it reverses an expense book took and tax
  // capitalises. They sit in the shared chart because the chart is per VEHICLE, not per book,
  // and an overlay entry has to reach a real account like any other.
  //
  // 1400 amortizes (§709, 180 months); 1450 never does. Keeping them apart is the same
  // distinction as 5200 vs 5250, carried onto the balance sheet — a single "deferred costs"
  // account would lose the one fact that decides whether the balance ever unwinds.
  { code: '1400', name: 'Deferred organizational costs (tax)', type: 'asset', subtype: 'deferred_org_costs' },
  { code: '1450', name: 'Capitalized syndication costs (tax)', type: 'asset', subtype: 'capitalized_syndication' },
  // A management fee paid before the related services are received. Unlike the tax-only 1400
  // and 1450 accounts above, this is an actual-book asset released to 5000 over the contractual
  // service period; a refundable unused balance remains an asset until repaid.
  { code: '1500', name: 'Prepaid management fees', type: 'asset', subtype: 'prepaid_management_fee' },

  // Liabilities
  { code: '2000', name: 'Accrued expenses', type: 'liability', subtype: 'accrued' },
  { code: '2100', name: 'Due to GP', type: 'liability', subtype: 'due_to_gp' },
  // Bridge/subscription line or other borrowing used to fund investments ahead of
  // capital calls; repaid as contributions arrive.
  { code: '2200', name: 'Loan payable', type: 'liability', subtype: 'loan_payable' },
  // Distributions declared but not yet wired. The mirror of 1300 on the way out: declaring
  // reduces the partner's capital and parks the obligation here; the bank outflow clears it.
  // Without a payable there is nothing for an outgoing wire to settle, so a distribution
  // could never be matched to the declaration it pays.
  { code: '2300', name: 'Distributions payable', type: 'liability', subtype: 'distributions_payable' },
  // A partner's wire that arrives before the call it pays. It is not capital yet — capital is
  // recognized at the call — so it waits here, per partner, and the next call applies it: the
  // partner's line is met from the advance and only the rest is due.
  { code: '2350', name: 'Capital contributions received in advance', type: 'liability', subtype: 'capital_advance' },

  // Equity — the GP account; per-LP capital accounts are added with lp_entity_id.
  { code: '3000', name: "Partners' capital — GP", type: 'equity', subtype: 'gp_capital' },
  { code: '3100', name: "Partners' capital — LP (unallocated)", type: 'equity', subtype: 'lp_capital' },
  // Bridge between the P&L (income statement) and partners' capital. Compound
  // fee/expense/income entries park the allocation offset here; the period close
  // zeroes it against the P&L accounts. See lib/accounting/entries.ts.
  { code: '3200', name: 'Undistributed earnings (bridge)', type: 'equity', subtype: 'undistributed_earnings' },

  // Income
  { code: '4000', name: 'Realized gain/(loss) on investments', type: 'income', subtype: 'realized_gain' },
  // Cash sitting in the bank, and dividends actually received. TREASURY income — it says
  // nothing about how the portfolio is doing.
  // INTEREST AND DIVIDENDS ARE SEPARATE ACCOUNTS because they are separate K-1 boxes — interest
  // is box 5, dividends are 6a, and the qualified part of dividends is 6b. One combined account
  // meant the tax side had to INFER the split by subtracting tagged portfolio income from the
  // total, which silently misclassified any dividend booked straight to the ledger without a
  // matching portfolio row. The account is the auditable source; the portfolio tag is now a
  // cross-check against it.
  { code: '4100', name: 'Interest income', type: 'income', subtype: 'interest_income' },
  { code: '4130', name: 'Dividend income', type: 'income', subtype: 'dividend_income' },
  // Interest EARNED BY A PORTFOLIO POSITION — a convertible note accruing at its coupon. This is
  // investment income, and keeping it apart from 4100 is the whole point: an LP reading the
  // income statement can then tell yield the portfolio produced from yield the bank account
  // produced. Both roll into `operatingIncome` on a capital account, but they are different
  // lines on the statement of operations, because they are different businesses.
  //
  // NOT for preferred dividends: those accrue to the liquidation preference and reach the
  // statements through the fair-value mark, never as income. See migration 20260714000007.
  { code: '4110', name: 'Note interest income', type: 'income', subtype: 'note_interest_income' },
  // Income a POSITION produced in a form that is neither a coupon nor a dividend — a staking
  // reward, an airdrop. Its own line because it is neither: 4100 is treasury yield and 4110 is a
  // contractual coupon, and a reward the protocol paid is a third thing an LP can reasonably ask
  // to see separately. Kept firmly out of 4200: it is income, not appreciation, and booking it
  // as a mark both inflates unrealized and leaves the units with no basis to sell against.
  { code: '4120', name: 'Staking and other portfolio income', type: 'income', subtype: 'portfolio_income' },
  { code: '4200', name: 'Change in unrealized appreciation', type: 'income', subtype: 'unrealized' },
  // The counterpart to 1250. Kept out of 4200 so the income statement can say how much
  // of the period's gain was the portfolio and how much was the dollar.
  { code: '4300', name: 'Foreign currency translation gain/(loss)', type: 'income', subtype: 'fx_translation' },

  // Expenses
  { code: '5000', name: 'Management fee', type: 'expense', subtype: 'management_fee' },
  { code: '5100', name: 'Partnership expenses', type: 'expense', subtype: 'partnership_expense' },
  { code: '5200', name: 'Organizational expenses', type: 'expense', subtype: 'organizational_expense' },
  // SYNDICATION COSTS ARE NOT ORGANIZATIONAL COSTS, and the difference is permanent.
  //
  // Organizational costs (forming the entity) are deductible for tax — $5,000 immediately,
  // phased out above $50,000, the rest amortized over 180 months under §709. Syndication costs
  // (selling the interests: placement fees, the offering memorandum, marketing) are NEVER
  // deductible and never amortized. Both are ordinary expenses for book.
  //
  // Without this account the two land together in 5200, and the tax book then amortizes
  // something that should sit permanently in capital — a difference that never reverses,
  // understating taxable income every year, forever. Splitting them at the point of entry is
  // the only way the book-to-tax adjustment can be derived instead of guessed.
  { code: '5250', name: 'Syndication costs', type: 'expense', subtype: 'syndication_cost' },
  { code: '5300', name: 'Interest expense', type: 'expense', subtype: 'interest_expense' },
]

/**
 * Starter chart for a GP / associate entity's own books (a separate vehicle from
 * the fund). Its stake in the fund is an asset carried at capital-account value
 * (equity method); its equity is members' capital; income is carry + its share
 * of fund earnings. Reconciles to the GP's capital account on the fund's books.
 */
export const GP_ENTITY_CHART: ChartAccountSeed[] = [
  // Assets
  { code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  // The GP's stake in the fund, split so each piece is visible rather than lumped together:
  //   1500 = cost (its funded capital commitment) — only cash contributions move it;
  //   1550 = the unrealized appreciation of that stake (its share of the fund's gains);
  //   1600 = carried interest earned, accrued as a receivable.
  { code: '1500', name: 'Investment in Fund', type: 'asset', subtype: 'investment_in_fund' },
  { code: '1550', name: 'Unrealized gain on Investment in Fund', type: 'asset', subtype: 'investment_in_fund_unrealized' },
  { code: '1600', name: 'Carried interest receivable', type: 'asset', subtype: 'carry_receivable' },

  // Liabilities
  { code: '2000', name: 'Accrued expenses', type: 'liability', subtype: 'accrued' },

  // Equity
  { code: '3000', name: "Members' capital", type: 'equity', subtype: 'members_capital' },
  // Same bridge the fund chart uses: the period close offsets each allocation to this account,
  // then rolls it into members' capital. Without it a GP/associate vehicle can't close a period.
  { code: '3200', name: 'Undistributed earnings (bridge)', type: 'equity', subtype: 'undistributed_earnings' },

  // Income
  { code: '4000', name: 'Carried interest income', type: 'income', subtype: 'carried_interest' },
  { code: '4100', name: 'Equity in earnings of Fund', type: 'income', subtype: 'equity_method' },
  { code: '4200', name: 'Management fee income', type: 'income', subtype: 'management_fee_income' },

  // Expenses
  { code: '5000', name: 'Operating expenses', type: 'expense', subtype: 'operating_expense' },
]

/**
 * The two intercompany parents, and the ONE thing every chart in this file agrees on.
 *
 * A charge between two vehicles books a receivable on one and a payable on the other, and the two
 * vehicles may hold entirely different charts — a manco's on one side, a fund's or a GP entity's
 * on the other. Rather than teach the intercompany code three chart layouts, both sides resolve
 * their leg through these codes, and `ensureIntercompanyAccounts` creates them (and the
 * per-counterparty sub-account beneath) on whichever chart is missing them.
 *
 * 1900/2900 because they are the only asset and liability codes unused by DEFAULT_CHART,
 * GP_ENTITY_CHART and MANAGEMENT_COMPANY_CHART alike. Reusing the fund chart's 2300 would have put
 * an intercompany payable directly under "Distributions payable" on an LP-facing balance sheet.
 */
export const INTERCOMPANY_RECEIVABLE_CODE = '1900'
export const INTERCOMPANY_PAYABLE_CODE = '2900'
export const INTERCOMPANY_RECEIVABLE_SUBTYPE = 'intercompany_receivable'
export const INTERCOMPANY_PAYABLE_SUBTYPE = 'intercompany_payable'

/**
 * Starter chart for a MANAGEMENT COMPANY — the firm's operating entity, as opposed to any
 * fund it manages.
 *
 * A manco is a normal business that happens to have one customer per fund. Its revenue is the
 * management fee, its costs are people and offices, and its balance sheet is mostly cash,
 * receivables from the funds, and what it owes its staff. None of the fund chart applies: there
 * are no investments at cost, no unrealized appreciation, no partners' capital per LP, no
 * schedule of investments, and nothing to allocate to anybody. Seeding DEFAULT_CHART on a manco
 * (what happened before `kind = 'manco'` existed) offers all of that and offers no salaries
 * account at all, which is the one line that matters most.
 *
 * Three deliberate choices, since a chart is mostly a set of decisions about what to keep apart:
 *
 * 1. COMPENSATION IS FOUR ACCOUNTS, not one. Salaries, employer payroll taxes, benefits and
 *    incentive compensation behave differently, are budgeted separately, and are asked about
 *    separately ("what does a head cost us?" is 5000+5010+5020; "what did we pay out on last
 *    year's performance?" is 5030). Rolling them together destroys all three answers and cannot
 *    be undone from the ledger afterwards.
 *
 * 2. THE FEE IS BILLED BEFORE IT IS EARNED, so 2400 exists. Management fees are almost always
 *    charged quarterly IN ADVANCE: the cash lands on 1 January for a quarter that has not
 *    happened. Recognising all of it as January income overstates Q1 revenue by two thirds and
 *    understates the liability to the fund by the same amount. 2400 holds the unearned part and
 *    releases it monthly, which is also what makes the quarterly revenue cycle on the manco
 *    dashboard mean anything.
 *
 * 3. INTERCOMPANY IS TWO ACCOUNTS AND THEY NEVER NET. 1200 is what the funds owe the manco, 2300
 *    is what the manco owes them (an expense it paid on their behalf, an advance). Presenting the
 *    net is how an intercompany balance stops reconciling: the two sides are with different
 *    counterparties, settle on different dates, and each has to agree to a matching payable or
 *    receivable on another entity's books. lib/accounting/intercompany.ts posts both sides of
 *    every charge against exactly these codes.
 */
export const MANAGEMENT_COMPANY_CHART: ChartAccountSeed[] = [
  // Assets
  { code: '1000', name: 'Cash \u2014 operating', type: 'asset', subtype: 'cash' },
  // A firm with a real balance keeps a second account; giving it its own code means the operating
  // balance on the dashboard is the runway number rather than the runway plus the reserve.
  { code: '1050', name: 'Cash \u2014 reserve', type: 'asset', subtype: 'cash' },
  { code: '1100', name: 'Accounts receivable', type: 'asset', subtype: 'receivable' },
  { code: '1300', name: 'Prepaid expenses', type: 'asset', subtype: 'prepaid' },
  { code: '1350', name: 'Security deposits', type: 'asset', subtype: 'deposit' },
  { code: '1400', name: 'Furniture, fixtures and equipment', type: 'asset', subtype: 'fixed_asset' },
  // Contra-asset: carries a CREDIT balance on an asset account, which is correct and intended.
  // Kept separate from 1400 so the gross cost of what the firm owns stays visible after it has
  // been written down to nothing.
  { code: '1450', name: 'Accumulated depreciation', type: 'asset', subtype: 'accumulated_depreciation' },
  // See note 3. 1900/2900 rather than a code next to the receivables, because these two are the
  // ONLY accounts every chart in this file has to agree on — `ensureIntercompanyAccounts` creates
  // `1900-<vehicle>` / `2900-<vehicle>` sub-accounts under them on a fund's chart and a GP entity's
  // as well as here, and 1900/2900 are the only codes free in all three.
  { code: '1900', name: 'Due from affiliates', type: 'asset', subtype: INTERCOMPANY_RECEIVABLE_SUBTYPE },

  // Liabilities
  { code: '2000', name: 'Accounts payable', type: 'liability', subtype: 'accounts_payable' },
  { code: '2100', name: 'Accrued expenses', type: 'liability', subtype: 'accrued' },
  // Bonuses declared and unpaid at year end are usually the largest single liability a manco
  // carries, and they are not an "accrued expense" in any useful sense \u2014 they are owed to named
  // people on a known date.
  { code: '2150', name: 'Accrued compensation', type: 'liability', subtype: 'accrued_compensation' },
  // Withholding and the employer's share, between payroll and the tax deposit. Money the firm is
  // holding for somebody else; never its own.
  { code: '2200', name: 'Payroll liabilities', type: 'liability', subtype: 'payroll_liability' },
  // See note 2.
  { code: '2400', name: 'Deferred management fee revenue', type: 'liability', subtype: 'deferred_revenue' },
  { code: '2500', name: 'Note payable', type: 'liability', subtype: 'note_payable' },
  { code: '2900', name: 'Due to affiliates', type: 'liability', subtype: INTERCOMPANY_PAYABLE_SUBTYPE },

  // Equity \u2014 members'/partners' capital in the firm, not LP capital in a fund.
  { code: '3000', name: "Members' capital", type: 'equity', subtype: 'members_capital' },
  // Draws are a CONTRA-EQUITY account, kept apart from 3000 so a year's distributions to the
  // partners can be read off the books instead of inferred from the movement in capital.
  { code: '3100', name: 'Member distributions', type: 'equity', subtype: 'member_distributions' },
  // The same bridge the fund and GP charts use: the period close offsets each P&L account here
  // and rolls the total into capital. Without it a manco cannot close a period at all.
  { code: '3200', name: 'Undistributed earnings (bridge)', type: 'equity', subtype: 'undistributed_earnings' },

  // Income
  { code: '4000', name: 'Management fee income', type: 'income', subtype: 'management_fee_income' },
  // A fee the funds reimburse rather than pay \u2014 an allocated cost, a shared-services charge.
  // Distinct from 4000 because it is cost recovery, not revenue: it moves with headcount and
  // spending, not with committed capital, and a firm reading "fee income" wants the fee.
  { code: '4100', name: 'Expense reimbursement income', type: 'income', subtype: 'reimbursement_income' },
  { code: '4200', name: 'Interest income', type: 'income', subtype: 'interest_income' },
  { code: '4900', name: 'Other income', type: 'income', subtype: 'other_income' },

  // Expenses \u2014 compensation first, because it is most of them. See note 1.
  { code: '5000', name: 'Salaries and wages', type: 'expense', subtype: 'salaries' },
  { code: '5010', name: 'Payroll taxes', type: 'expense', subtype: 'payroll_taxes' },
  { code: '5020', name: 'Employee benefits', type: 'expense', subtype: 'benefits' },
  { code: '5030', name: 'Bonus and incentive compensation', type: 'expense', subtype: 'incentive_compensation' },
  { code: '5100', name: 'Rent and occupancy', type: 'expense', subtype: 'occupancy' },
  { code: '5200', name: 'Legal fees', type: 'expense', subtype: 'legal' },
  { code: '5210', name: 'Audit, tax and accounting fees', type: 'expense', subtype: 'professional_fees' },
  { code: '5220', name: 'Fund administration', type: 'expense', subtype: 'fund_administration' },
  { code: '5300', name: 'Technology and software', type: 'expense', subtype: 'technology' },
  { code: '5400', name: 'Travel and entertainment', type: 'expense', subtype: 'travel' },
  { code: '5500', name: 'Marketing and business development', type: 'expense', subtype: 'marketing' },
  { code: '5600', name: 'Insurance', type: 'expense', subtype: 'insurance' },
  { code: '5700', name: 'Office and general', type: 'expense', subtype: 'office' },
  // Non-cash, and the manco dashboard subtracts it back out when it shows cash burn \u2014 which is
  // only possible because it has a code of its own.
  { code: '5800', name: 'Depreciation and amortization', type: 'expense', subtype: 'depreciation' },
  { code: '5900', name: 'Interest expense', type: 'expense', subtype: 'interest_expense' },
]

/** Codes the management-company chart guarantees, for the surfaces that post to them by code. */
export const MANCO_CODES = {
  cash: '1000',
  deferredRevenue: '2400',
  managementFeeIncome: '4000',
  reimbursementIncome: '4100',
  bridge: '3200',
} as const


/**
 * The intercompany sub-account code for a counterparty vehicle, e.g. 1900-<vehicle>.
 *
 * Same shape and same reason as `lpCapitalCode`: one account per counterparty, so a balance can be
 * read per entity rather than as a single pooled number nobody can reconcile — and reconciling is
 * the entire job of an intercompany account. The 8-character prefix is a vehicle id, unique enough
 * within one fund's chart and short enough to read in a picker.
 */
export function intercompanyCode(base: string, counterpartyVehicleId: string): string {
  return `${base}-${counterpartyVehicleId.slice(0, 8)}`
}

/**
 * Which starter chart a vehicle gets, from its `fund_vehicles.kind`.
 *
 * One function rather than the ternary that used to sit in both the chart route and the turn-on
 * route: two copies of "which chart" is how a third kind gets added to one of them and not the
 * other, and the symptom of that is a vehicle seeded with the wrong accounts, discovered months
 * later by an accountant looking for a line that was never created.
 */
export function chartForVehicleKind(kind: string | null | undefined): ChartAccountSeed[] {
  if (kind === 'manco') return MANAGEMENT_COMPANY_CHART
  if (kind === 'associate') return GP_ENTITY_CHART
  if (kind === 'individual') return INDIVIDUAL_CHART
  return DEFAULT_CHART
}

/**
 * Starter chart for an INDIVIDUAL — an angel investing for their own account, or the
 * single-member LLC they do it through (a disregarded entity, so the same books).
 *
 * The investment side is the fund chart's, code for code: per-company cost and unrealized
 * accounts hang off 1100/1200 exactly as they do for a fund, so the schedule of investments, the
 * marks and the realized-gain lots all work unchanged. What differs is the other two thirds:
 *
 *   - EQUITY IS ONE OWNER. Owner's capital (subtype `members_capital`, the same subtype the
 *     management company closes to, so one owner's-equity close serves both) and owner draws.
 *     No GP, no LP, no bridge allocation — the close rolls net income straight into 3000.
 *   - EXPENSES ARE THE PREPARER'S LINES. A fund's chart has partnership and organizational
 *     expenses; an individual's return asks about investment expenses, professional fees,
 *     software, travel, home office, dues, education. Seeding those names is what lets the
 *     year-end export be keyed straight onto the schedule rather than reclassified by hand.
 *
 * No 1300 Due from LPs, no 2100 Due to GP, no 5250 syndication: none of those can happen to a
 * person. The bridge (3200) stays because every close in this codebase posts through it.
 */
export const INDIVIDUAL_CHART: ChartAccountSeed[] = [
  // Assets
  { code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  { code: '1100', name: 'Investments at cost', type: 'asset', subtype: 'investment' },
  { code: '1200', name: 'Unrealized appreciation/(depreciation)', type: 'asset', subtype: 'unrealized' },
  { code: '1250', name: 'Foreign currency translation', type: 'asset', subtype: 'fx_translation' },
  { code: '1350', name: 'Escrow receivable', type: 'asset', subtype: 'escrow_receivable' },

  // Liabilities
  { code: '2000', name: 'Accrued expenses', type: 'liability', subtype: 'accrued' },
  { code: '2100', name: 'Credit card payable', type: 'liability', subtype: 'credit_card' },
  { code: '2200', name: 'Loan payable', type: 'liability', subtype: 'loan_payable' },

  // Equity — one owner.
  { code: '3000', name: "Owner's capital", type: 'equity', subtype: 'members_capital' },
  { code: '3100', name: "Owner's draws", type: 'equity', subtype: 'member_distributions' },
  { code: '3200', name: 'Undistributed earnings (bridge)', type: 'equity', subtype: 'undistributed_earnings' },

  // Income — the same lines a fund keeps, because the same things happen to a position.
  { code: '4000', name: 'Realized gain/(loss) on investments', type: 'income', subtype: 'realized_gain' },
  { code: '4100', name: 'Interest income', type: 'income', subtype: 'interest_income' },
  { code: '4110', name: 'Note interest income', type: 'income', subtype: 'note_interest_income' },
  { code: '4120', name: 'Staking and other portfolio income', type: 'income', subtype: 'portfolio_income' },
  { code: '4130', name: 'Dividend income', type: 'income', subtype: 'dividend_income' },
  { code: '4200', name: 'Change in unrealized appreciation', type: 'income', subtype: 'unrealized' },
  { code: '4300', name: 'Foreign currency translation gain/(loss)', type: 'income', subtype: 'fx_translation' },

  // Expenses — the lines a personal return asks about.
  { code: '5100', name: 'Investment expenses', type: 'expense', subtype: 'partnership_expense' },
  { code: '5200', name: 'Professional fees (legal, tax, accounting)', type: 'expense', subtype: 'professional_fees' },
  { code: '5300', name: 'Software and subscriptions', type: 'expense', subtype: 'technology' },
  { code: '5400', name: 'Travel and meals', type: 'expense', subtype: 'travel' },
  { code: '5500', name: 'Home office', type: 'expense', subtype: 'occupancy' },
  { code: '5600', name: 'Dues and memberships', type: 'expense', subtype: 'dues' },
  { code: '5700', name: 'Education and events', type: 'expense', subtype: 'education' },
  { code: '5800', name: 'Interest expense', type: 'expense', subtype: 'interest_expense' },
  { code: '5900', name: 'Other expenses', type: 'expense', subtype: 'operating_expense' },
]

/** The per-LP capital account code for an entity, e.g. 3100-<entity>. */
export function lpCapitalCode(lpEntityId: string): string {
  return `3100-${lpEntityId.slice(0, 8)}`
}
