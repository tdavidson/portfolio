import type { Domain } from '@/lib/access/domains'
import type { AccessLevel } from '@/lib/access/effective'
import type { FeatureKey } from '@/lib/types/features'

/**
 * What /start offers before anything has been asked.
 *
 * Both lists are filtered through the SAME resolver the sidebar uses, so the landing page never
 * advertises a question the Analyst will refuse to answer or a form the API will 403. That is the
 * whole reason this is a pure function rather than JSX with `useCanRead` sprinkled through it:
 * the ordering and the filtering are the part worth pinning in a test.
 *
 * Affordances only — nothing here is a boundary. `/api/analyst` gates its own context by domain
 * and every create action posts to a gated route.
 */
export type Can = (domain: Domain, feature?: FeatureKey) => AccessLevel

interface Gated {
  domain: Domain
  /** Overrides the domain's primary switch, exactly as in the nav and the route registry. */
  feature?: FeatureKey
}

export interface SuggestedPrompt extends Gated {
  /** Stable key — tests pin these rather than the prose, which will be reworded. */
  id: string
  text: string
}

export interface CreateAction extends Gated {
  id: string
  /**
   * Used verbatim for `link` actions. For `modal` actions it is documentation: the page renders
   * that action's existing trigger component, which carries its own label so the wording stays the
   * same wherever the button appears.
   */
  label: string
  /**
   * `modal` actions are rendered by /start from an existing reusable button component; `link`
   * actions navigate to the page that owns the form. Deal and LP creation live inside their own
   * pages' dialogs with no reusable trigger, so they are links until one exists.
   */
  kind: 'modal' | 'link'
  href?: string
  /**
   * Which row of the shortcut strip. Portfolio creation on the first; the capital movements —
   * a call in, a distribution out — on a second, because they are a different kind of act from
   * adding a record and read better as their own pair than as the tail of a long row.
   */
  group: 'create' | 'capital'
  /**
   * Admins only, on top of the grant. Creating a vehicle is fund setup — a new set of books —
   * and the shortcut strip is not the place to hand that to every member with the accounting
   * grant, even though the route would let them. The nav shows Entities to those members
   * regardless; this is about what the front door OFFERS, not what the API allows.
   */
  adminOnly?: boolean
  /**
   * A second gate that must be READABLE for the action to show, on top of the write gate above.
   * For an action whose page sits inside another product's section: the capital pair lives under
   * Entities, so a fund with Entities hidden must not be offered a shortcut into it, whatever the
   * LPs setting says. Exactly the sidebar's rule — a child shows only when its parent does.
   */
  within?: Gated
}

/**
 * Ordered widest-first: a fund running Portfolio Reporting alone should still see a full row, and
 * the accounting/LP questions only surface once those products are on.
 */
const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  { id: 'portfolio-quarter', text: 'How is the portfolio doing this quarter?', domain: 'portfolio' },
  { id: 'portfolio-silent', text: 'Which companies have not reported recently?', domain: 'portfolio' },
  { id: 'lp-unfunded', text: 'Who has the largest unfunded commitment?', domain: 'lp_capital', feature: 'lp_tracking' },
  { id: 'dealflow-new', text: 'What came into the pipeline this month?', domain: 'dealflow', feature: 'deals' },
  { id: 'diligence-stalled', text: 'Which deals are in due diligence?', domain: 'diligence' },
]

/**
 * A brand-new fund has nothing to ask about yet, so the portfolio questions above would only get
 * "there is no data". While the fund holds no companies, these replace them: questions the
 * Analyst can answer from the product itself. Gated on `portfolio` because that is the domain the
 * emptiness was read from (see isSetupStage) — the same bar as the prompts they stand in for.
 */
const SETUP_PROMPTS: SuggestedPrompt[] = [
  { id: 'setup-help', text: 'Help me set up my fund', domain: 'portfolio' },
  { id: 'setup-import-first', text: 'What do I need to import first?', domain: 'portfolio' },
  { id: 'setup-lps', text: 'How do I bring in my LPs and their commitments?', domain: 'portfolio' },
]

/** Shown ahead of the create shortcuts while the fund is in setup. A guide, so read is enough. */
const SETUP_ACTIONS: CreateAction[] = [
  { id: 'getting-started', label: 'Getting started', kind: 'link', href: '/getting-started', domain: 'portfolio', group: 'create' },
]

const CREATE_ACTIONS: CreateAction[] = [
  // First because it is the thing a fund does most often between reports. Same feature switch
  // as the company page's Investment Details and the investments API — the modal posts there.
  { id: 'add-investment', label: 'Add investment', kind: 'modal', domain: 'portfolio', feature: 'investments', group: 'create' },
  { id: 'add-company', label: 'Add a company', kind: 'modal', domain: 'portfolio', group: 'create' },
  { id: 'import-documents', label: 'Import documents', kind: 'modal', domain: 'portfolio', feature: 'imports', group: 'create' },
  { id: 'add-deal', label: 'Add a deal', kind: 'link', href: '/deals', domain: 'dealflow', feature: 'deals', group: 'create' },
  { id: 'add-vehicle', label: 'Add a vehicle', kind: 'modal', domain: 'accounting', group: 'create', adminOnly: true },
  // Both live on the capital accounts page as one panel with two directions; `action` tells it
  // which to open (lib/accounting/capital-action.ts). Gated exactly as that page is in the nav
  // (lib/accounting/nav.ts): on `lp_capital` with NO feature override, so the LPs visibility
  // setting — the fund's choice of who sees partner capital — is the one that decides, the same
  // way it decides for the routes they post to. `within` adds the section they sit in.
  { id: 'issue-capital-call', label: 'Issue a capital call', kind: 'link', href: '/funds/capital-accounts?action=call', domain: 'lp_capital', within: { domain: 'accounting' }, group: 'capital' },
  { id: 'declare-distribution', label: 'Declare a distribution', kind: 'link', href: '/funds/capital-accounts?action=distribution', domain: 'lp_capital', within: { domain: 'accounting' }, group: 'capital' },
]

const canRead = (can: Can, g: Gated) => {
  const level = can(g.domain, g.feature)
  return level !== 'none'
}

/**
 * Questions to seed the composer with. Read is the right bar: a chip only promises the Analyst
 * will have the context to answer, not that the user may change anything.
 */
export function suggestedPrompts(can: Can, limit = 4, opts: { setup?: boolean } = {}): SuggestedPrompt[] {
  return (opts.setup ? SETUP_PROMPTS : SUGGESTED_PROMPTS).filter(p => canRead(can, p)).slice(0, limit)
}

/**
 * Is this fund still being set up, as far as Start is concerned? True only when the caller can
 * read the portfolio AND counted no companies there. `companyCount` is read under the caller's own
 * RLS, which answers 0 to someone without the portfolio domain — so 0 alone proves nothing, and
 * null (the count failed) is never "empty".
 */
export function isSetupStage(can: Can, companyCount: number | null): boolean {
  return companyCount === 0 && canRead(can, { domain: 'portfolio' })
}

/**
 * Create shortcuts. Write, not read — offering "Add a company" to a viewer produces a form whose
 * save button 403s, which is worse than not offering it.
 */
export function createActions(can: Can, opts: { isAdmin?: boolean; setup?: boolean } = {}): CreateAction[] {
  const create = CREATE_ACTIONS
    .filter(a => !a.adminOnly || !!opts.isAdmin)
    .filter(a => !a.within || canRead(can, a.within))
    .filter(a => can(a.domain, a.feature) === 'write')
  return opts.setup ? [...SETUP_ACTIONS.filter(a => canRead(can, a)), ...create] : create
}
