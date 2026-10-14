// The deterministic first pass over an imported bank row: which account in THIS entity's chart
// should the non-cash side of its draft entry hit, and how sure are we?
//
// Three ideas, in the order they run:
//
// 1. HISTORY BEATS KEYWORDS. If this entity has already booked the same payee to one account,
//    a person has answered the question before. A rule guessing from words in the memo can only
//    be worse than that answer.
//
// 2. RULES NAME A KIND OF ACCOUNT, NOT A CODE. The charts differ by vehicle kind — 3100 is LP
//    capital on a fund, member distributions on a management company, and absent on a GP
//    entity. A rule that says "3100" books a manco's revenue as a draw. So every rule names the
//    account SUBTYPES it wants, in preference order, and is resolved against the entity's real
//    chart. A rule whose accounts the chart doesn't have simply doesn't fire.
//
// 3. NEVER BOOK AGAINST CASH. When nothing fits, the result says so (accountCode null) rather
//    than falling back to cash on both sides — an entry that nets to zero and looks fine.
//
// Pure: the loader that gathers the chart, the history and the sibling vehicles lives in
// bank-categorize-context.ts.

import type { AccountType } from './types'
import type { ParsedTxn } from './bank'

export interface ChartAccountRef {
  code: string
  name: string
  type: AccountType
  subtype?: string | null
  /** A per-partner capital sub-account. Never a target: naming a partner is the settlement path's job. */
  lpEntityId?: string | null
}

/** Another vehicle in the same fund — the other side of a transfer between the firm's own accounts. */
export interface Affiliate {
  vehicleId: string
  names: string[]
}

/** A bank row this entity has already booked, reduced to what the next row can learn from it. */
export interface HistoryEntry {
  payee: string
  inflow: boolean
  accountCode: string
  /** A person chose this account (re-pointed the row), as opposed to posting what was suggested. */
  chosen: boolean
}

export type CategorySource = 'history' | 'rule' | 'fallback' | 'ai' | 'user'

export interface Categorization {
  /** Chart account code for the NON-cash side, or null when nothing in the chart fits. */
  accountCode: string | null
  sourceType: string
  label: string
  confidence: 'high' | 'low'
  by: CategorySource
  /** One line a reviewer can read: why this account. */
  reason: string
}

export interface CategorizeContext {
  chart: ChartAccountRef[]
  /** The vehicle's own id, so a transfer is never read as "to itself". */
  vehicleId?: string | null
  affiliates?: Affiliate[]
  history?: HistoryEntry[]
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Lower-case, punctuation to spaces, whitespace collapsed. */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Words bank feeds wrap around the payee. They say how the money moved, not who it went to, so
// two payments to one vendor — one by card, one by ACH — must reduce to the same key.
const FEED_NOISE = new Set([
  'pos', 'debit', 'credit', 'card', 'purchase', 'checkcard', 'visa', 'mastercard', 'ach', 'ppd',
  'ccd', 'web', 'tel', 'id', 'des', 'indn', 'co', 'orig', 'entry', 'descr', 'sec', 'trn', 'ref',
  'wire', 'transfer', 'xfer', 'online', 'payment', 'pmt', 'recurring', 'autopay', 'bill', 'pay',
  'outgoing', 'incoming', 'domestic', 'intl', 'international', 'fedwire', 'bene', 'beneficiary',
  'from', 'to', 'the', 'and', 'for', 'of', 'inc', 'llc', 'ltd', 'corp', 'com', 'www', 'https',
  'http', 'sent', 'received', 'funds', 'deposit', 'withdrawal', 'electronic', 'preauthorized',
  'mobile', 'external', 'internal', 'book', 'via', 'on', 'at', 'us', 'usa', 'na',
])

/**
 * The payee a row is FROM or TO, as a stable key: the counterparty when the feed has one,
 * otherwise the description, with feed boilerplate, reference numbers and dates removed.
 * "POS DEBIT 0412 SLACK T12345 SAN FRANCISCO" and "ACH PMT SLACK TECHNOLOGIES" both start "slack".
 * Null when nothing distinctive is left — such a row has nothing to learn from.
 */
export function payeeKey(t: { description?: string | null; counterparty?: string | null }): string | null {
  const source = (t.counterparty && t.counterparty.trim()) || t.description || ''
  const tokens = normalizeText(source).split(' ')
    .filter(w => w.length >= 2 && !/\d/.test(w) && !FEED_NOISE.has(w))
  if (tokens.length === 0) return null
  return tokens.slice(0, 2).join(' ')
}

// ---------------------------------------------------------------------------
// Chart resolution
// ---------------------------------------------------------------------------

/**
 * The account in the chart for the first subtype it has. Parent accounts only: a per-partner
 * capital account or a per-company investment account (code with a suffix) is never picked by
 * a rule, because choosing one means choosing a partner or a company.
 */
export function accountForSubtypes(chart: ChartAccountRef[], subtypes: string[]): ChartAccountRef | null {
  for (const s of subtypes) {
    const found = chart
      .filter(a => a.subtype === s && !a.lpEntityId && !a.code.includes('-'))
      .sort((a, b) => a.code.localeCompare(b.code))[0]
    if (found) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Direction = 'in' | 'out' | 'any'

interface Rule {
  when: Direction
  re: RegExp
  /** Account subtypes, most specific first. The first one the chart has wins. */
  subtypes: string[]
  sourceType: string
  label: string
}

// Expense targets end in the general buckets each chart has, so a fund (which has no "software"
// account) still lands a software bill in partnership expenses, and a management company lands
// it in Technology and software.
const EXPENSE_FALLBACK = ['partnership_expense', 'operating_expense', 'office']

/**
 * Ordered most specific first. Every pattern matches whole words — "tax" must not fire on
 * "taxi", "admin" not on "administrator's lunch". Every rule states a direction: money IN is
 * never an expense and money OUT is never a capital contribution, which is how an outgoing
 * software "subscription" used to be booked as a capital call.
 */
const RULES: Rule[] = [
  // Capital and distributions.
  { when: 'in', re: /\b(capital call|drawdown|capital contribution|contribution|subscription)\b/, subtypes: ['lp_capital', 'members_capital'], sourceType: 'capital_call', label: 'Capital contribution' },
  { when: 'out', re: /\b(distribution|redemption|member draw|owner draw|draw)\b/, subtypes: ['lp_capital', 'member_distributions'], sourceType: 'distribution', label: 'Distribution' },
  // An escrow release CLEARS the receivable booked at exit — it is not new income. The escrow
  // receipt recorded on the holding posts that (Dr cash, Cr 1350), so this row is flagged as an
  // escrow release and LINKED to the receipt's entry; posting it to 1350 itself is refused
  // (ESCROW_VIA_HOLDING), or the receivable would clear twice.
  { when: 'any', re: /\b(escrow|holdback)\b/, subtypes: ['escrow_receivable'], sourceType: 'realized_gain', label: 'Escrow release — link it to the receipt on the holding' },

  // Fees. The same words mean revenue to the manager and a cost to the fund.
  { when: 'out', re: /\b(management fee|mgmt fee)\b/, subtypes: ['management_fee'], sourceType: 'management_fee', label: 'Management fee' },
  { when: 'in', re: /\b(management fee|mgmt fee|advisory fee)\b/, subtypes: ['management_fee_income'], sourceType: 'income', label: 'Management fee income' },
  { when: 'in', re: /\b(reimbursement|reimburse|expense recovery)\b/, subtypes: ['reimbursement_income'], sourceType: 'income', label: 'Expense reimbursement' },

  // People. Taxes before wages: "payroll tax" is a tax, not a salary.
  { when: 'out', re: /\b(payroll tax|payroll taxes|eftps|futa|suta|941 tax)\b/, subtypes: ['payroll_taxes', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Payroll taxes' },
  { when: 'out', re: /\b(payroll|salary|salaries|wages|gusto|adp|paychex|rippling|justworks|trinet)\b/, subtypes: ['salaries', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Salaries and wages' },
  { when: 'out', re: /\b(health insurance|dental|vision|401k|401 k|retirement plan|benefits|aetna|cigna|kaiser|blue cross|blue shield|unitedhealthcare|guardian)\b/, subtypes: ['benefits', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Employee benefits' },

  // Professional services.
  { when: 'out', re: /\b(legal|law firm|law office|attorney|attorneys|counsel)\b/, subtypes: ['legal', 'professional_fees', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Legal fees' },
  { when: 'out', re: /\b(fund admin|fund administration|fund administrator)\b/, subtypes: ['fund_administration', 'professional_fees', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Fund administration' },
  { when: 'out', re: /\b(filing fee|registered agent|franchise tax|annual report fee|fund expense)\b/, subtypes: [...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Partnership expense' },
  { when: 'out', re: /\b(audit|auditor|tax|taxes|accounting|accountant|cpa|bookkeeping)\b/, subtypes: ['professional_fees', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Audit, tax and accounting' },
  { when: 'out', re: /\b(consultant|consulting|contractor)\b/, subtypes: ['professional_fees', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Professional fees' },
  { when: 'out', re: /\b(organizational|organization costs|formation)\b/, subtypes: ['organizational_expense', ...EXPENSE_FALLBACK], sourceType: 'organizational_expense', label: 'Organizational expense' },

  // Running an office.
  { when: 'out', re: /\b(marketing|advertising|ads|sponsorship|conference)\b/, subtypes: ['marketing', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Marketing and business development' },
  { when: 'out', re: /\b(software|saas|subscription|license|licence|google|gsuite|workspace|microsoft|slack|zoom|docusign|dropbox|adobe|notion|intuit|quickbooks|aws|github|atlassian|salesforce)\b/, subtypes: ['technology', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Software and subscriptions' },
  { when: 'out', re: /\b(rent|lease|wework|regus|office space)\b/, subtypes: ['occupancy', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Rent and occupancy' },
  { when: 'out', re: /\b(insurance|premium)\b/, subtypes: ['insurance', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Insurance' },
  { when: 'out', re: /\b(airline|airlines|airways|hotel|marriott|hilton|hyatt|airbnb|uber|lyft|taxi|amtrak|expedia|restaurant|travel)\b/, subtypes: ['travel', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Travel and entertainment' },
  { when: 'out', re: /\b(wire fee|service charge|service fee|bank fee|monthly fee|maintenance fee|analysis fee|overdraft)\b/, subtypes: ['bank_fees', 'office', ...EXPENSE_FALLBACK], sourceType: 'partnership_expense', label: 'Bank fees' },
]

/** A card balance being paid down: a liability moving, not an expense. Only where the chart has a card account. */
const CARD_PAYMENT = /\b(credit card|card services|amex|american express)\b.*\b(payment|pmt|autopay|epay)\b|\b(payment|pmt|autopay|epay)\b.*\b(credit card|card services|amex|american express)\b/

/**
 * Money moving between the firm's own accounts, not to or from the world. "WIRE TRANSFER TO
 * <vendor>" is a payment that happens to travel by wire, so a bare wire is not a transfer
 * unless it names a sibling vehicle.
 */
const OWN_TRANSFER = /\b(online transfer|internal transfer|book transfer|account transfer|funds transfer|transfer from|transfer to|xfer)\b/

// Words that every legal name carries and that say nothing about WHICH entity.
const ENTITY_SUFFIX = new Set(['lp', 'llc', 'l', 'p', 'inc', 'ltd', 'co', 'the', 'llp', 'gp'])

/**
 * Which sibling vehicle does this description name, if exactly one? Every distinctive word of the
 * vehicle's name must appear as a whole word — including short ones like "ii", which is what
 * tells "Fund II" from "Fund I". The vehicle naming the most words wins; a tie is no answer.
 */
export function affiliateNamed(text: string, affiliates: Affiliate[], selfId?: string | null): Affiliate | null {
  const words = new Set(normalizeText(text).split(' '))
  let best: { a: Affiliate; score: number } | null = null
  let tie = false
  for (const a of affiliates) {
    if (selfId && a.vehicleId === selfId) continue
    for (const name of a.names) {
      const tokens = normalizeText(name).split(' ').filter(w => w && !ENTITY_SUFFIX.has(w))
      if (tokens.length === 0 || !tokens.every(w => words.has(w))) continue
      // One word ("Fund") is a word, not a name.
      if (tokens.length < 2 && tokens[0].length < 5) continue
      if (!best || tokens.length > best.score) { best = { a, score: tokens.length }; tie = false }
      else if (tokens.length === best.score && best.a.vehicleId !== a.vehicleId) tie = true
    }
  }
  return best && !tie ? best.a : null
}

/** The intercompany account for this direction: per-counterparty when the chart has one, else the parent. */
function intercompanyAccount(chart: ChartAccountRef[], inflow: boolean, affiliate: Affiliate | null): ChartAccountRef | null {
  // Money IN from an affiliate: it now owes us less, or we owe it more — book it as due TO the
  // affiliate. Money OUT: due FROM. The reviewer settles which side when an agreement exists.
  const subtype = inflow ? 'intercompany_payable' : 'intercompany_receivable'
  if (affiliate) {
    const suffix = `-${affiliate.vehicleId.slice(0, 8)}`
    const sub = chart.find(a => a.subtype === subtype && a.code.endsWith(suffix))
    if (sub) return sub
  }
  return chart.filter(a => a.subtype === subtype && !a.code.includes('-')).sort((a, b) => a.code.localeCompare(b.code))[0] ?? null
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** How much agreement history needs before it outranks the rules. */
const HISTORY_MIN_SHARE = 0.8

/**
 * What this entity did with the same payee before, in the same direction. One person's explicit
 * choice is enough; otherwise it takes two bookings. Either way the winning account must hold at
 * least 80% of them — a payee split across accounts is a question, not an answer.
 */
export function learnedAccount(
  t: Pick<ParsedTxn, 'amount' | 'description' | 'counterparty'>,
  history: HistoryEntry[],
  chart: ChartAccountRef[],
): { account: ChartAccountRef; count: number; total: number } | null {
  const key = payeeKey(t)
  if (!key) return null
  const inflow = t.amount >= 0
  const valid = new Set(chart.filter(a => !a.lpEntityId && a.subtype !== 'cash').map(a => a.code))
  const same = history.filter(h => h.payee === key && h.inflow === inflow && valid.has(h.accountCode))
  if (same.length === 0) return null
  const counts = new Map<string, { n: number; chosen: boolean }>()
  for (const h of same) {
    const c = counts.get(h.accountCode) ?? { n: 0, chosen: false }
    counts.set(h.accountCode, { n: c.n + 1, chosen: c.chosen || h.chosen })
  }
  const [code, top] = Array.from(counts.entries()).sort((a, b) => b[1].n - a[1].n)[0]
  if (top.n / same.length < HISTORY_MIN_SHARE) return null
  if (top.n < 2 && !top.chosen) return null
  const account = chart.find(a => a.code === code)
  return account ? { account, count: top.n, total: same.length } : null
}

/** The source type an account implies when history, not a rule, chose it. */
export function sourceTypeForAccount(a: ChartAccountRef, inflow: boolean): string {
  switch (a.subtype) {
    case 'investment': return inflow ? 'realized_gain' : 'manual'
    case 'lp_capital': return inflow ? 'capital_call' : 'distribution'
    case 'members_capital': return inflow ? 'capital_call' : 'distribution'
    case 'member_distributions': return 'distribution'
    case 'management_fee': return 'management_fee'
    case 'organizational_expense': return 'organizational_expense'
    case 'escrow_receivable': return 'realized_gain'
  }
  if (a.type === 'income') return 'income'
  if (a.type === 'expense') return 'partnership_expense'
  return 'manual'
}

// ---------------------------------------------------------------------------
// The categorizer
// ---------------------------------------------------------------------------

/**
 * Suggest the non-cash account for a bank row against the entity's own chart. History first,
 * then transfers between the firm's own vehicles, then interest, then keyword rules, then a
 * direction fallback flagged low-confidence for review.
 */
export function categorizeBankRow(t: ParsedTxn, ctx: CategorizeContext): Categorization {
  const { chart } = ctx
  const inflow = t.amount >= 0
  // Match against the description, the counterparty AND the activity/type column — brokerage
  // feeds put the meaningful keyword ("Interest Income") in a separate Activity column while the
  // description is just the counterparty name.
  const text = normalizeText(`${t.description || ''} ${t.counterparty || ''} ${t.activity || ''}`)

  const learned = ctx.history?.length ? learnedAccount(t, ctx.history, chart) : null
  if (learned) {
    return {
      accountCode: learned.account.code,
      sourceType: sourceTypeForAccount(learned.account, inflow),
      label: learned.account.name,
      confidence: 'high',
      by: 'history',
      reason: `This payee was booked to ${learned.account.name} ${learned.count === 1 ? 'before, by hand' : `${learned.count} of ${learned.total} times before`}`,
    }
  }

  // Between the firm's own vehicles.
  const affiliate = ctx.affiliates?.length ? affiliateNamed(text, ctx.affiliates, ctx.vehicleId) : null
  if (affiliate || (OWN_TRANSFER.test(text) && !/\bwire\b/.test(text))) {
    const acct = intercompanyAccount(chart, inflow, affiliate)
    if (acct) {
      return {
        accountCode: acct.code, sourceType: 'manual', label: acct.name,
        // Naming the vehicle is a strong signal; a bare "online transfer" could be between two of
        // this entity's own bank accounts, which is not intercompany at all.
        confidence: affiliate ? 'high' : 'low', by: 'rule',
        reason: affiliate ? `Names ${affiliate.names[0]}, another vehicle in this fund` : 'Reads as a transfer between your own accounts — confirm which entity is on the other side',
      }
    }
  }

  if (!inflow && CARD_PAYMENT.test(text)) {
    const acct = accountForSubtypes(chart, ['credit_card'])
    if (acct) return { accountCode: acct.code, sourceType: 'manual', label: acct.name, confidence: 'high', by: 'rule', reason: 'A credit card payment pays down the card balance' }
  }

  // Interest/dividend: income when received, expense when paid (e.g. brokerage margin interest).
  if (/\b(interest|dividend|dividends)\b/.test(text)) {
    if (inflow) {
      // Two K-1 boxes, so two accounts. The word in the bank line is the only signal there
      // is at this point, and it is a better one than lumping both into interest.
      const dividend = /\bdividends?\b/.test(text)
      const acct = accountForSubtypes(chart, dividend ? ['dividend_income', 'interest_income', 'other_income'] : ['interest_income', 'other_income'])
      if (acct) return { accountCode: acct.code, sourceType: 'income', label: dividend ? 'Dividend income' : 'Interest income', confidence: 'high', by: 'rule', reason: `Mentions ${dividend ? 'a dividend' : 'interest'} received` }
    } else {
      const acct = accountForSubtypes(chart, ['interest_expense', ...EXPENSE_FALLBACK])
      if (acct) return { accountCode: acct.code, sourceType: 'partnership_expense', label: 'Interest expense', confidence: 'high', by: 'rule', reason: 'Mentions interest paid' }
    }
  }

  for (const r of RULES) {
    if (r.when === 'in' && !inflow) continue
    if (r.when === 'out' && inflow) continue
    const m = text.match(r.re)
    if (!m) continue
    const acct = accountForSubtypes(chart, r.subtypes)
    if (!acct) continue
    return {
      accountCode: acct.code, sourceType: r.sourceType, label: r.label,
      // High even when the chart has no dedicated account and the rule settled for a general one:
      // a fund's audit bill belongs in partnership expenses, and flagging every such row would
      // bury the ones that genuinely need a look.
      confidence: 'high',
      by: 'rule',
      reason: `Mentions "${m[0]}"`,
    }
  }

  // Nothing recognised: the likeliest account by direction, flagged for review.
  const acct = (inflow
    ? accountForSubtypes(chart, ['lp_capital', 'other_income', 'members_capital'])
    : accountForSubtypes(chart, EXPENSE_FALLBACK))
    ?? chart.filter(a => a.type === (inflow ? 'income' : 'expense') && !a.code.includes('-')).sort((a, b) => a.code.localeCompare(b.code))[0]
    ?? null
  return {
    accountCode: acct?.code ?? null,
    sourceType: acct ? sourceTypeForAccount(acct, inflow) : 'manual',
    label: inflow ? 'Unclassified inflow' : 'Unclassified expense',
    confidence: 'low',
    by: 'fallback',
    reason: acct ? 'Nothing recognised — a default by direction' : 'No account in this chart fits',
  }
}

/** What gets stored on the bank row (`raw.categorization`): who chose the account, how sure, and why. */
export interface CategorizationRecord {
  by: CategorySource
  confidence: 'high' | 'low'
  reason: string
}

export function categorizationRecord(c: Pick<Categorization, 'by' | 'confidence' | 'reason'>): CategorizationRecord {
  return { by: c.by, confidence: c.confidence, reason: c.reason }
}
