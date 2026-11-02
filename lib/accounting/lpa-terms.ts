// Reading a fund's waterfall terms out of its LPA — PURE: no database, no model.
//
// The output is a PROPOSAL in the engine's shape (VehicleCarryTerms, docs/spec/waterfall-terms.md),
// never a write. Every field carries the clause it came from, where that clause is (section, page),
// a confidence, and whether the quoted words were actually found in the document; a field nobody
// could find is listed in `notFound` rather than defaulted silently. A person applies a proposal
// with `set_waterfall_terms`, which is always staged for approval.
//
// Three readers produce the same shape:
//   * the fund's own model, when the fund has a server AI key (lpa-terms-run.ts sends it
//     `buildLpaTermsPrompt` and parses the answer with `parseLpaTermsResponse`);
//   * the person's connected assistant, when it has none: it reads `relevantPassages` itself and
//     hands its reading back in the same JSON (`assistantProposal`), which is parsed and checked
//     the same way — so a model's answer and an assistant's answer pass the same gate;
//   * `heuristicLpaTerms`, a plain pattern reader that always runs, so a proposal exists (at low or
//     medium confidence) even before anyone has read the clauses.
//
// Quote verification is the guard against a reader that paraphrases or invents: a quote that does
// not appear in the document (whitespace, case and typographic quotes aside) caps that field at
// low confidence and says so.

import type { CarryKind, PrefBase, VehicleCarryTerms, WaterfallScope } from './carry'
import type { FeeBasis } from './fees'

export type Confidence = 'high' | 'medium' | 'low'

/** Where a proposed value came from. */
export interface TermSource {
  /** The clause, verbatim from the document. */
  quote: string
  /** The section or article heading the clause sits under, when one could be found. */
  section: string | null
  /** The page, from the extracted text's [Page N] markers, when known. */
  page: number | null
  confidence: Confidence
  /** Whether `quote` was found in the document text. False caps confidence at low. */
  quoteVerified: boolean
  note?: string
}

export interface ProposedField<T> extends TermSource {
  value: T
}

/** The fields the engine stores in vehicle_waterfall_terms (recipients are matched separately). */
export const TERM_FIELDS = ['kind', 'carryRate', 'prefRate', 'prefCompounds', 'prefBase', 'catchupRate', 'catchupSize', 'waterfallScope'] as const
export type TermField = typeof TERM_FIELDS[number]

/** Read for the record only: the management fee is a forecast-plan rule and a per-close input, not a waterfall term. */
export const INFO_FIELDS = ['managementFeeRate', 'managementFeeBasis'] as const
export type InfoField = typeof INFO_FIELDS[number]

export interface ProposedTerms {
  kind?: ProposedField<CarryKind>
  carryRate?: ProposedField<number>
  prefRate?: ProposedField<number>
  prefCompounds?: ProposedField<boolean>
  prefBase?: ProposedField<PrefBase>
  catchupRate?: ProposedField<number>
  catchupSize?: ProposedField<number>
  waterfallScope?: ProposedField<WaterfallScope>
}

export interface ProposedInfo {
  managementFeeRate?: ProposedField<number>
  managementFeeBasis?: ProposedField<FeeBasis>
}

/** A provision the LPA has that the engine does not model (docs/spec/waterfall-terms.md §7). */
export interface UnsupportedProvision {
  provision: string
  quote: string
  section: string | null
  page: number | null
  quoteVerified: boolean
}

export type ExtractionMethod = 'server_model' | 'assistant' | 'heuristic'

export interface LpaTermsProposal {
  method: ExtractionMethod
  terms: ProposedTerms
  info: ProposedInfo
  /** Fields no reader found a clause for. */
  notFound: (TermField | InfoField)[]
  unsupported: UnsupportedProvision[]
  warnings: string[]
}

// ─── Text layout: paragraphs with their page and section ─────────────────────────────────────────

export interface Passage {
  text: string
  page: number | null
  section: string | null
  /** Character offset of the passage in the document text. */
  offset: number
}

const PAGE_MARKER = /\[Page (\d+)\]/
const SECTION_HEADING = /^\s*((?:section|article|clause)\s+[0-9ivxlc]+(?:\.[0-9a-z]+)*\b[^\n]{0,90}|[0-9]+(?:\.[0-9]+)+\.?\s+[A-Z][^\n]{0,90})\s*$/i

/** Split the document into paragraphs, each tagged with the page and section it falls under. */
export function passagesOf(text: string): Passage[] {
  const out: Passage[] = []
  let page: number | null = null
  let section: string | null = null
  let buf: string[] = []
  let bufStart = 0
  let offset = 0

  const flush = () => {
    const joined = buf.join(' ').replace(/\s+/g, ' ').trim()
    if (joined) {
      // A run-on paragraph (OCR often loses blank lines) is cut at sentence ends into ~1,200-char pieces.
      if (joined.length <= 1500) out.push({ text: joined, page, section, offset: bufStart })
      else {
        let piece = ''
        for (const sentence of joined.split(/(?<=[.;])\s+/)) {
          if (piece && piece.length + sentence.length > 1200) {
            out.push({ text: piece.trim(), page, section, offset: bufStart })
            piece = ''
          }
          piece += sentence + ' '
        }
        if (piece.trim()) out.push({ text: piece.trim(), page, section, offset: bufStart })
      }
    }
    buf = []
  }

  for (const line of text.split('\n')) {
    const lineStart = offset
    offset += line.length + 1
    const marker = line.match(PAGE_MARKER)
    if (marker) {
      flush()
      page = Number(marker[1])
      continue
    }
    if (!line.trim()) { flush(); continue }
    const heading = line.match(SECTION_HEADING)
    if (heading && line.trim().length <= 110) {
      flush()
      section = heading[1].replace(/\s+/g, ' ').trim()
      // A heading that runs straight into its text ("Section 4.1 Distributions. All amounts…") is
      // both: keep its words as the passage's first line too.
      buf = [line]
      bufStart = lineStart
      continue
    }
    if (buf.length === 0) bufStart = lineStart
    buf.push(line)
  }
  flush()
  return out
}

const RELEVANT = /carried interest|\bcarry\b|incentive (?:allocation|distribution)|performance (?:allocation|fee)|promote|preferred return|priority return|hurdle|catch[- ]?up|management fee|distributions?\b.*\b(?:general partner|limited partners)|return of capital|capital contributions? .*returned|clawback|claw-back|giveback|deal[- ]by[- ]deal/i

/**
 * The passages a reader needs, most relevant first, within a character budget: the distribution
 * waterfall, the carry and hurdle definitions, the management fee and anything that looks like a
 * clawback. What an assistant reads instead of the whole agreement.
 */
export function relevantPassages(text: string, maxChars = 40_000): Passage[] {
  const scored = passagesOf(text)
    .map((p, i) => ({ p, i, score: scoreOf(p.text) }))
    .filter(s => s.score > 0)
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i))
  const chosen: { p: Passage; i: number }[] = []
  let used = 0
  for (const s of scored) {
    if (used + s.p.text.length > maxChars) continue
    chosen.push(s)
    used += s.p.text.length
  }
  // Back in document order, so a waterfall's tiers read in sequence.
  return chosen.sort((a, b) => a.i - b.i).map(s => s.p)
}

function scoreOf(t: string): number {
  if (!RELEVANT.test(t)) return 0
  let s = 1
  if (/catch[- ]?up/i.test(t)) s += 3
  if (/preferred return|hurdle|priority return/i.test(t)) s += 3
  if (/carried interest|incentive (?:allocation|distribution)|performance allocation/i.test(t)) s += 3
  if (/thereafter|remainder|balance/i.test(t) && /general partner/i.test(t)) s += 2
  if (/management fee/i.test(t)) s += 2
  if (PERCENT.test(t)) s += 1
  PERCENT.lastIndex = 0
  return s
}

// ─── Quote verification ──────────────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .replace(/\[Page \d+\]/g, ' ')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Whether the quoted words appear in the document — whitespace, case, page breaks and typographic quotes aside. */
export function verifyQuote(quote: string, text: string): boolean {
  const q = normalize(quote).replace(/^\.{3}|\.{3}$/g, '').trim()
  if (q.length < 8) return false
  const t = normalize(text)
  if (t.includes(q)) return true
  // A quote stitched with an ellipsis must have every piece in the document, in order.
  const parts = q.split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean)
  if (parts.length < 2) return false
  let from = 0
  for (const part of parts) {
    const at = t.indexOf(part, from)
    if (at < 0) return false
    from = at + part.length
  }
  return true
}

/** The page and section of a verified quote, from the passage that contains it. */
function locate(quote: string, passages: Passage[]): { page: number | null; section: string | null } | null {
  const q = normalize(quote).split(/\s*(?:\.\.\.|…)\s*/)[0]
  if (!q) return null
  const probe = q.slice(0, 80)
  const hit = passages.find(p => normalize(p.text).includes(probe))
  return hit ? { page: hit.page, section: hit.section } : null
}

// ─── The heuristic reader ────────────────────────────────────────────────────────────────────────

const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b|per cent\b)/gi
const GP = String.raw`(?:the\s+)?(?:general\s+partner|gp\b|carr(?:y|ied\s+interest)\s+(?:partner|recipient|holder)s?|special\s+limited\s+partner|managing\s+member|manager)`
/** "20% to the General Partner", "twenty percent (20%) of such amounts to the General Partner". */
const SHARE_TO_GP = new RegExp(String.raw`(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b|per cent\b)\)?\s+(?:of\s+(?:such|the|all|any)[^.;%]{0,80}?\s+)?(?:shall\s+be\s+(?:distributed|paid|allocated)\s+)?to\s+${GP}`, 'i')
/** "the General Partner shall receive 20%" — a percentage the GP is given, not one it must reach. */
const GP_RECEIVES = new RegExp(String.raw`${GP}\s+(?:shall\s+)?(?:receive|be\s+(?:entitled|allocated|paid|distributed))[^.;%]{0,30}?(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b|per cent\b)`, 'i')
/** "until the General Partner has received 20% of the aggregate…" — the catch-up's target, which is the carry rate. */
const CATCHUP_TARGET = new RegExp(String.raw`until\s+${GP}\s+(?:has|shall\s+have)\s+(?:received|been\s+(?:distributed|allocated))[^.;%]{0,60}?(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b|per cent\b)`, 'i')

function percentsIn(t: string): number[] {
  const out: number[] = []
  for (const m of t.matchAll(PERCENT)) out.push(Number(m[1]))
  return out
}

/** A passage cut into its tiers: "(i) … ; (ii) … ; (iii) …". */
function clausesOf(p: Passage): Passage[] {
  const parts = p.text.split(/;\s+|(?=\(\s*(?:i{1,3}|iv|vi{0,3}|ix|x|[a-h]|[1-9])\s*\)\s)/i).map(s => s.trim()).filter(s => s.length > 12)
  return parts.length > 1 ? parts.map(text => ({ ...p, text })) : [p]
}

function clip(s: string, max = 500): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'
}

function field<T>(value: T, at: Passage, confidence: Confidence, note?: string): ProposedField<T> {
  return { value, quote: clip(at.text), section: at.section, page: at.page, confidence, quoteVerified: true, ...(note ? { note } : {}) }
}

const CARRY_WORDS = /carried interest|\bcarry\b|incentive (?:allocation|distribution)|performance (?:allocation|fee)|promote|thereafter|remainder|balance/i
const CATCHUP_WORDS = /catch[- ]?up/i
const PREF_WORDS = /preferred return|priority return|hurdle|preferred amount/i
const FEE_WORDS = /management fee/i

/**
 * Read the terms with patterns alone. Never above medium confidence: it finds the clause and the
 * number in it, and a person (or a model) should still read the clause.
 */
export function heuristicLpaTerms(text: string): LpaTermsProposal {
  const passages = passagesOf(text)
  const clauses = passages.flatMap(clausesOf)
  const terms: ProposedTerms = {}
  const info: ProposedInfo = {}
  const warnings: string[] = []

  // Catch-up: the GP's share of the catch-up flow.
  const catchUp = clauses.filter(c => CATCHUP_WORDS.test(c.text))
  for (const c of catchUp) {
    const m = c.text.match(SHARE_TO_GP) ?? c.text.match(GP_RECEIVES)
    if (m && Number(m[1]) > 0 && Number(m[1]) <= 100) {
      terms.catchupRate = field(Number(m[1]) / 100, c, 'medium')
      break
    }
    if (/\b(?:all|entirely|solely)\b[^.;]{0,40}to\s+the\s+general\s+partner/i.test(c.text)) {
      terms.catchupRate = field(1, c, 'low', 'Read as a full (100%) catch-up from "all … to the General Partner".')
      break
    }
  }
  // Carry: the GP's share of the final split, in a carry/remainder clause that is not the catch-up.
  const carryShares: { value: number; at: Passage }[] = []
  for (const c of clauses) {
    if (CATCHUP_WORDS.test(c.text) || FEE_WORDS.test(c.text) || !CARRY_WORDS.test(c.text)) continue
    const m = c.text.match(SHARE_TO_GP) ?? c.text.match(GP_RECEIVES)
    if (m) {
      const v = Number(m[1])
      if (v > 0 && v <= 50) carryShares.push({ value: v / 100, at: c })
    }
  }
  let carryAt: Passage | null = null
  if (carryShares.length > 0) {
    carryAt = carryShares[0].at
    terms.carryRate = field(carryShares[0].value, carryAt, 'medium')
    const distinct = Array.from(new Set(carryShares.map(s => s.value)))
    if (distinct.length > 1) {
      warnings.push(`More than one GP share was found in carry clauses (${distinct.map(v => `${+(v * 100).toFixed(4)}%`).join(', ')}); the first is proposed. Read the clauses: the LPA may have tiered carry, which the engine does not model.`)
    }
  } else {
    // The catch-up's target names the carry rate ("until the GP has received 20% of …").
    for (const c of catchUp) {
      const m = c.text.match(CATCHUP_TARGET)
      if (m && Number(m[1]) > 0 && Number(m[1]) <= 50) {
        terms.carryRate = field(Number(m[1]) / 100, c, 'low', "Taken from the catch-up's target, not from a carry split clause.")
        carryAt = c
        break
      }
    }
    if (!terms.carryRate) {
      const def = clauses.find(c => /carried interest/i.test(c.text) && !FEE_WORDS.test(c.text) && percentsIn(c.text).filter(v => v >= 5 && v <= 50).length === 1)
      if (def) {
        terms.carryRate = field(percentsIn(def.text).find(v => v >= 5 && v <= 50)! / 100, def, 'low', 'The only percentage in a clause that mentions carried interest.')
        carryAt = def
      }
    }
  }

  // Preferred return: a rate, and whether it compounds.
  const prefClauses = clauses.filter(c => PREF_WORDS.test(c.text) && !FEE_WORDS.test(c.text))
  const prefRates: { value: number; at: Passage }[] = []
  for (const c of prefClauses) {
    for (const v of percentsIn(c.text)) {
      if (v >= 1 && v <= 25 && /per annum|annual|per year|a year|compound|simple|internal rate of return|\birr\b|cumulative/i.test(c.text)) {
        prefRates.push({ value: v / 100, at: c })
      }
    }
  }
  if (prefRates.length > 0) {
    terms.prefRate = field(prefRates[0].value, prefRates[0].at, 'medium')
    const distinct = Array.from(new Set(prefRates.map(s => s.value)))
    if (distinct.length > 1) {
      warnings.push(`More than one hurdle rate was found (${distinct.map(v => `${+(v * 100).toFixed(4)}%`).join(', ')}); the first is proposed. The engine has one hurdle.`)
    }
  }
  const compoundAt = [...(prefRates.length ? [prefRates[0].at] : []), ...prefClauses]
  for (const c of compoundAt) {
    if (/non[- ]?compound|not\s+(?:be\s+)?compounded|simple\s+(?:interest|basis|rate|return)|without\s+compounding/i.test(c.text)) {
      terms.prefCompounds = field(false, c, 'medium'); break
    }
    if (/compound/i.test(c.text)) {
      terms.prefCompounds = field(true, c, 'medium'); break
    }
    if (/internal rate of return|\birr\b/i.test(c.text)) {
      terms.prefCompounds = field(true, c, 'low', 'An IRR hurdle compounds; the engine compounds annually from each contribution date.'); break
    }
  }
  // What the hurdle accrues on. Only the unreturned wording is distinctive; "capital contributions"
  // alone is how both readings are written, so silence is left as not found.
  const unreturnedAt = prefClauses.find(c => UNRETURNED.test(c.text))
  if (unreturnedAt) terms.prefBase = field<PrefBase>('unreturned', unreturnedAt, 'medium')

  // A waterfall per LP: proceeds divided among the LPs first, then each LP's share through the tiers.
  const perLpAt = passages.find(p => PER_LP.some(re => re.test(p.text)))
  if (perLpAt) terms.waterfallScope = field<WaterfallScope>('per_lp', perLpAt, 'medium', 'Proceeds are divided among the partners before the tiers, so each LP\'s share runs through its own waterfall.')

  // Kind.
  const all = passages.map(p => p.text).join('\n')
  const dealByDeal = passages.find(p => /deal[- ]by[- ]deal|investment[- ]by[- ]investment|with respect to each (?:portfolio )?investment[^.]{0,120}(?:carried interest|general partner)/i.test(p.text))
  if (dealByDeal) terms.kind = field<CarryKind>('american', dealByDeal, 'medium')
  else if (carryAt && (terms.prefRate || terms.catchupRate)) {
    const at = passages.find(p => /whole[- ]fund|aggregate capital contributions|all capital contributions|cumulative capital contributions/i.test(p.text))
    terms.kind = at
      ? field<CarryKind>('european', at, 'medium')
      : field<CarryKind>('european', prefRates[0]?.at ?? catchUp[0] ?? carryAt, 'low', 'A hurdle or catch-up ahead of the carry split reads as a whole-fund (European) waterfall.')
  } else if (carryAt) {
    terms.kind = field<CarryKind>('straight', carryAt, 'low', 'Carry with no hurdle or catch-up found reads as straight carry. Check there is no preferred return elsewhere.')
  }

  // Management fee (for the record).
  const feeClauses = clauses.filter(c => FEE_WORDS.test(c.text))
  for (const c of feeClauses) {
    const v = percentsIn(c.text).find(x => x >= 0.25 && x <= 5)
    if (v != null) {
      info.managementFeeRate = field(v / 100, c, 'medium')
      const basis: FeeBasis | null =
        /net asset value|\bnav\b/i.test(c.text) ? 'nav'
        : /invested capital|net invested|cost basis of (?:the )?(?:portfolio )?investments|capital invested/i.test(c.text) ? 'invested'
        : /capital commitments?|committed capital|aggregate commitments?/i.test(c.text) ? 'committed'
        : null
      if (basis) info.managementFeeBasis = field(basis, c, 'medium')
      if (/step[- ]?down|reduced to|thereafter[^.]{0,80}(\d+(?:\.\d+)?)\s*%/i.test(c.text)) {
        warnings.push('The management fee clause appears to step down or change basis after a period; only the first rate is proposed.')
      }
      break
    }
  }

  const unsupported = detectUnsupported(passages)
  if (!/carried interest|\bcarry\b|incentive|performance allocation|promote/i.test(all)) {
    warnings.push('No clause mentions carried interest: the vehicle may have no carry (kind "none"), or the relevant pages have not been read yet.')
  }

  return finish({ method: 'heuristic', terms, info, unsupported, warnings })
}

/**
 * An LPA that divides proceeds among the partners first (by capital contributions) and then runs
 * each partner's share through the tiers: "apportioned among the Partners in proportion to their
 * Capital Contributions, and the amount apportioned to each Limited Partner shall be distributed
 * between such Limited Partner and the General Partner as follows". Kept generic: the division, then
 * the per-partner application.
 */
const PER_LP = [
  /(?:apportioned|allocated|divided|shared)\s+(?:among|between)\s+the\s+(?:limited\s+)?partners[^.]{0,200}(?:capital contributions?|contribution percentages?|percentage interests?)[^]{0,400}?(?:amount|portion|share)s?\s+(?:so\s+)?(?:apportioned|allocated|attributable)\s+to\s+(?:each|any|such|a)\s+(?:limited\s+)?partner/i,
  /(?:amount|portion|share)s?\s+(?:so\s+)?(?:apportioned|allocated|attributable)\s+to\s+(?:each|any|such|a)\s+(?:limited\s+)?partner[^.]{0,200}(?:distributed|paid|applied)[^.]{0,120}(?:between|to)\s+(?:such|that|the)\s+(?:limited\s+)?partner\s+and\s+the\s+general\s+partner/i,
]

/** A hurdle that accrues only on capital not yet returned (prefBase 'unreturned'). */
const UNRETURNED = /(?:preferred return|hurdle|per annum)[^.]{0,200}(?:unreturned|outstanding|net of (?:prior )?distributions|not (?:yet )?(?:been )?returned)/i

/** Provisions the engine does not model, each with the clause that has it. */
export function detectUnsupported(passages: Passage[]): UnsupportedProvision[] {
  const checks: { provision: string; re: RegExp }[] = [
    { provision: 'GP clawback (carry give-back)', re: /claw[- ]?back|give[- ]?back|return[^.]{0,60}excess[^.]{0,40}(?:carried interest|distributions)/i },
    { provision: 'Carry escrow or holdback', re: /(?:escrow|holdback|held back|reserve)[^.]{0,80}carried interest|carried interest[^.]{0,80}(?:escrow|holdback|held back)/i },
    { provision: 'Management fee offset', re: /(?:offset|reduce[ds]?|credit(?:ed)?)[^.]{0,80}management fee[^.]{0,120}(?:transaction|monitoring|director|break[- ]up|other) fees|(?:transaction|monitoring|director|break[- ]up) fees[^.]{0,120}(?:offset|reduce|credit)[^.]{0,60}management fee/i },
    { provision: 'Tax distributions', re: /tax distributions?/i },
    { provision: 'Tiered or multiple hurdles', re: /(?:second|additional|further|higher)\s+(?:hurdle|preferred return|tier)/i },
    { provision: 'GP commitment carry-free or fee-free treatment', re: /(?:no|not bear|shall not be subject to)[^.]{0,40}(?:carried interest|management fee)[^.]{0,80}general partner|general partner[^.]{0,80}(?:not bear|shall not be subject to|exempt)[^.]{0,40}(?:carried interest|management fee)/i },
  ]
  const out: UnsupportedProvision[] = []
  for (const { provision, re } of checks) {
    const hit = passages.find(p => re.test(p.text))
    if (hit) out.push({ provision, quote: clip(hit.text), section: hit.section, page: hit.page, quoteVerified: true })
  }
  return out
}

function finish(p: Omit<LpaTermsProposal, 'notFound'>): LpaTermsProposal {
  // A catch-up's size is only stated when it is partial; unstated, it is a full catch-up.
  const notFound = [
    // Silence on the waterfall's scope is the whole fund, the usual reading.
    ...TERM_FIELDS.filter(f => p.terms[f] == null && f !== 'catchupSize' && f !== 'waterfallScope'),
    ...INFO_FIELDS.filter(f => p.info[f] == null),
  ]
  // A straight carry needs no hurdle or catch-up: "not found" is the expected answer there.
  const straight = p.terms.kind?.value === 'straight' || p.terms.kind?.value === 'none'
  return {
    ...p,
    notFound: straight ? notFound.filter(f => f !== 'prefRate' && f !== 'prefCompounds' && f !== 'prefBase' && f !== 'catchupRate') : notFound,
  }
}

// ─── A model's (or an assistant's) reading ──────────────────────────────────────────────────────

/** The JSON a reader returns. Shared by the server prompt and the assistant's instructions. */
export const LPA_TERMS_RESPONSE_SHAPE = `{
  "kind":               { "value": "european" | "american" | "straight" | "none", "quote": "...", "section": "...", "page": 12, "confidence": "high" | "medium" | "low" } | null,
  "carryRate":          { "value": 0.20, ... } | null,
  "prefRate":           { "value": 0.08, ... } | null,
  "prefCompounds":      { "value": true, ... } | null,
  "prefBase":           { "value": "contributed" | "unreturned", ... } | null,
  "catchupRate":        { "value": 1.0, ... } | null,
  "catchupSize":        { "value": 1.0, ... } | null,
  "waterfallScope":     { "value": "fund" | "per_lp", ... } | null,
  "managementFeeRate":  { "value": 0.02, ... } | null,
  "managementFeeBasis": { "value": "committed" | "invested" | "nav", ... } | null,
  "unsupported": [ { "provision": "GP clawback", "quote": "...", "section": "...", "page": 40 } ],
  "notes": [ "..." ]
}`

export const LPA_TERMS_RULES = `Rules:
- Rates are FRACTIONS: 20% carry is 0.20; an 8% preferred return is 0.08; a full catch-up is 1.0 (the GP's share of the catch-up flow; 0.8 for an 80/20 catch-up).
- kind: "european" = whole-fund (all contributed capital and the preferred return come back before any carry); "american" = deal-by-deal carry; "straight" = carry on profit with no preferred return or catch-up; "none" = no carried interest.
- prefCompounds: true when the preferred return compounds (annually, or an IRR hurdle), false when it is simple.
- catchupRate is the share of each dollar that goes to the GP WHILE it catches up (1.0 when all of it does; 0.8 for 80/20; 0.1 is possible even on 20% carry). catchupSize is how much of a full catch-up the GP gets, where a full one is the carry it would have earned on the profit that paid the preferred return: 1.0 for a full catch-up, 0.5 when the GP catches up to half of that. null when the text does not limit the catch-up.
- prefBase: "unreturned" when the preferred return accrues only on capital contributions not yet returned (or "outstanding", "net of distributions"); "contributed" when it plainly accrues on all capital contributions regardless of returns; null when the text does not say.
- waterfallScope: "per_lp" when the LPA first divides each distribution among the partners (usually in proportion to their capital contributions) and then runs EACH partner's share through the return of capital, preferred return, catch-up and split separately; "fund" when the tiers run on the partners' aggregate amounts; null when the text does not say.
- kind "american" also covers a waterfall that returns the capital of realized investments (and write-offs) before carry, rather than all contributed capital.
- managementFeeBasis: "committed" (on capital commitments), "invested" (on invested capital / cost of investments), "nav" (on net asset value).
- quote: copy the clause VERBATIM from the text (you may shorten with "..." but never reword). section: the section or article it sits under. page: from the nearest [Page N] marker before it, or null.
- Use null for a term the text does not state. Never guess a market-standard value.
- unsupported: list every provision that changes who gets what but is not one of the fields above: GP clawback, carry escrow/holdback, management fee offsets, multiple hurdles or tiered carry, tax distributions, step-downs.`

/** The server model's prompt: the relevant passages, the shape, the rules. */
export function buildLpaTermsPrompt(passages: Passage[]): string {
  const body = passages
    .map(p => `${p.page != null ? `[Page ${p.page}] ` : ''}${p.section ? `(${p.section}) ` : ''}${p.text}`)
    .join('\n\n')
  return `You are reading a limited partnership agreement to find its distribution waterfall and economic terms.

Return ONLY valid JSON in this exact shape (no markdown, no explanation):
${LPA_TERMS_RESPONSE_SHAPE}

${LPA_TERMS_RULES}

Passages from the agreement:
${body}`
}

const CONFIDENCES: Confidence[] = ['high', 'medium', 'low']
const KINDS: CarryKind[] = ['none', 'straight', 'american', 'european']
const BASES: FeeBasis[] = ['committed', 'invested', 'nav']

/** A rate as a fraction. A reader that says 20 (or "20%") means 0.20; 1 means 1% except for the catch-up, where 1 is 100%. */
export function rateFraction(v: unknown, field: 'carryRate' | 'prefRate' | 'catchupRate' | 'catchupSize' | 'managementFeeRate'): number | null {
  let n: number
  if (typeof v === 'string') {
    const m = v.trim().match(/^(-?\d+(?:\.\d+)?)\s*(%)?$/)
    if (!m) return null
    n = Number(m[1])
    if (m[2]) return n / 100
  } else if (typeof v === 'number') n = v
  else return null
  if (!Number.isFinite(n) || n < 0) return null
  if (field === 'catchupRate' || field === 'catchupSize') return n <= 1 ? n : n <= 100 ? n / 100 : null
  return n < 1 ? n : n <= 100 ? n / 100 : null
}

function inRange(field: TermField | InfoField, v: number): boolean {
  switch (field) {
    case 'carryRate': return v >= 0 && v < 1
    case 'prefRate': return v >= 0 && v < 1
    case 'catchupRate': return v >= 0 && v <= 1
    case 'managementFeeRate': return v >= 0 && v < 0.2
    default: return true
  }
}

/** Pull the JSON object out of a reply that may be wrapped in a code fence or prose. */
export function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('No JSON object found in the reply.')
  return JSON.parse(candidate.slice(start, end + 1))
}

/**
 * Check a reader's JSON against the document. Each field must have the right type and range and a
 * quote; a quote not found in the document caps it at low confidence. A field that fails is
 * dropped to `notFound` with a warning saying why — never passed through.
 */
export function parseLpaTermsResponse(raw: unknown, documentText: string, method: Exclude<ExtractionMethod, 'heuristic'>): LpaTermsProposal {
  const obj = (typeof raw === 'string' ? extractJsonObject(raw) : raw) as Record<string, any> | null
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('The reading must be a JSON object.')
  const passages = passagesOf(documentText)
  const warnings: string[] = []
  const terms: ProposedTerms = {}
  const info: ProposedInfo = {}

  const read = <T>(name: TermField | InfoField, coerce: (v: unknown) => T | null): ProposedField<T> | undefined => {
    const f = obj[name]
    if (f == null) return undefined
    if (typeof f !== 'object' || Array.isArray(f)) { warnings.push(`${name}: expected an object with value and quote; ignored.`); return undefined }
    const value = coerce(f.value)
    if (value === null) { warnings.push(`${name}: ${JSON.stringify(f.value)} is not a valid value; ignored.`); return undefined }
    if (typeof value === 'number' && !inRange(name, value)) { warnings.push(`${name}: ${value} is out of range; ignored.`); return undefined }
    const quote = typeof f.quote === 'string' ? f.quote.trim() : ''
    if (!quote) { warnings.push(`${name}: no quote given, so it cannot be checked against the LPA; ignored.`); return undefined }
    const verified = verifyQuote(quote, documentText)
    const where = verified ? locate(quote, passages) : null
    let confidence: Confidence = CONFIDENCES.includes(f.confidence) ? f.confidence : 'medium'
    let note = typeof f.note === 'string' && f.note.trim() ? f.note.trim() : undefined
    if (!verified) {
      confidence = 'low'
      note = [note, 'The quoted words were not found in the document text; read the clause before relying on this.'].filter(Boolean).join(' ')
    }
    return {
      value,
      quote: clip(quote, 800),
      section: typeof f.section === 'string' && f.section.trim() ? f.section.trim() : where?.section ?? null,
      page: Number.isInteger(f.page) && f.page > 0 ? f.page : where?.page ?? null,
      confidence,
      quoteVerified: verified,
      ...(note ? { note } : {}),
    }
  }

  const kind = read<CarryKind>('kind', v => (typeof v === 'string' && (KINDS as string[]).includes(v) ? v as CarryKind : null))
  if (kind) terms.kind = kind
  const carryRate = read<number>('carryRate', v => rateFraction(v, 'carryRate'))
  if (carryRate) terms.carryRate = carryRate
  const prefRate = read<number>('prefRate', v => rateFraction(v, 'prefRate'))
  if (prefRate) terms.prefRate = prefRate
  const prefCompounds = read<boolean>('prefCompounds', v => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null))
  if (prefCompounds) terms.prefCompounds = prefCompounds
  const prefBase = read<PrefBase>('prefBase', v => (v === 'contributed' || v === 'unreturned' ? v : null))
  if (prefBase) terms.prefBase = prefBase
  const catchupRate = read<number>('catchupRate', v => rateFraction(v, 'catchupRate'))
  if (catchupRate) terms.catchupRate = catchupRate
  const catchupSize = read<number>('catchupSize', v => rateFraction(v, 'catchupSize'))
  if (catchupSize) terms.catchupSize = catchupSize
  const waterfallScope = read<WaterfallScope>('waterfallScope', v => (v === 'fund' || v === 'per_lp' ? v : null))
  if (waterfallScope) terms.waterfallScope = waterfallScope
  const fee = read<number>('managementFeeRate', v => rateFraction(v, 'managementFeeRate'))
  if (fee) info.managementFeeRate = fee
  const basis = read<FeeBasis>('managementFeeBasis', v => (typeof v === 'string' && (BASES as string[]).includes(v) ? v as FeeBasis : null))
  if (basis) info.managementFeeBasis = basis

  const unsupported: UnsupportedProvision[] = Array.isArray(obj.unsupported)
    ? obj.unsupported
        .filter((u: any) => u && typeof u.provision === 'string' && u.provision.trim())
        .slice(0, 20)
        .map((u: any) => {
          const quote = typeof u.quote === 'string' ? clip(u.quote.trim(), 800) : ''
          const verified = quote ? verifyQuote(quote, documentText) : false
          const where = verified ? locate(quote, passages) : null
          return {
            provision: String(u.provision).trim().slice(0, 120),
            quote,
            section: typeof u.section === 'string' && u.section.trim() ? u.section.trim() : where?.section ?? null,
            page: Number.isInteger(u.page) && u.page > 0 ? u.page : where?.page ?? null,
            quoteVerified: verified,
          }
        })
    : []
  // What the patterns see that the reader did not mention still matters to the approver.
  for (const u of detectUnsupported(passages)) {
    if (!unsupported.some(x => x.provision.toLowerCase().split(/\W+/)[0] === u.provision.toLowerCase().split(/\W+/)[0])) unsupported.push(u)
  }

  if (Array.isArray(obj.notes)) for (const n of obj.notes.slice(0, 10)) if (typeof n === 'string' && n.trim()) warnings.push(n.trim().slice(0, 500))
  if (terms.kind?.value === 'straight' && terms.prefRate && terms.prefRate.value > 0) {
    warnings.push('kind is straight but a preferred return was read: straight carry ignores the hurdle (spec §4.2). Check whether the LPA is a European waterfall.')
  }
  if (terms.kind?.value === 'none' && terms.carryRate && terms.carryRate.value > 0) {
    warnings.push('kind is none but a carry rate was read: with kind none no carry accrues and distributions are pro-rata.')
  }
  if (terms.kind?.value === 'american' && terms.waterfallScope?.value === 'per_lp') {
    warnings.push('kind is american and the waterfall is read as per LP: a deal-by-deal waterfall per LP is not supported, so it is proposed for the whole fund. Read the clause.')
  }

  return finish({ method, terms, info, unsupported, warnings })
}

// ─── From proposal to the terms set_waterfall_terms takes ───────────────────────────────────────

export interface ProposedTermsInput {
  kind: CarryKind
  carryRate: number
  prefRate: number
  catchupRate: number
  catchupSize: number
  prefCompounds: boolean
  prefBase: PrefBase
  /** Recipients are not in an LPA by entity id: today's are kept, or a person names them. */
  carryRecipients: { lpEntityId: string; pct: number }[]
  /** Only when the LPA says, or the vehicle already runs per LP; absent is the whole fund. */
  waterfallScope?: WaterfallScope
}

/**
 * The full set of terms to stage: the proposal's values, and for every field it lacks, the
 * vehicle's current value (or the engine's default), named in `filledFrom` so the approver sees it.
 * A straight or no-carry kind zeroes the hurdle and resets the catch-up, as the engine reads them.
 */
export function proposalToTermsInput(
  proposal: LpaTermsProposal,
  current: VehicleCarryTerms,
): { input: ProposedTermsInput; filledFrom: Partial<Record<TermField | 'carryRecipients', 'current' | 'default'>> } {
  const filledFrom: Partial<Record<TermField | 'carryRecipients', 'current' | 'default'>> = {}
  const currentHas = current.kind !== 'none' || current.carryRate > 0
  const pick = <K extends TermField>(k: K, fallback: NonNullable<ProposedTerms[K]>['value'], cur: NonNullable<ProposedTerms[K]>['value']) => {
    const p = proposal.terms[k]
    if (p) return p.value
    filledFrom[k] = currentHas ? 'current' : 'default'
    return currentHas ? cur : fallback
  }
  const kind = pick('kind', 'none', current.kind) as CarryKind
  const input: ProposedTermsInput = {
    kind,
    carryRate: pick('carryRate', 0, current.carryRate) as number,
    prefRate: pick('prefRate', 0, current.prefRate) as number,
    catchupRate: pick('catchupRate', 1, current.catchupRate) as number,
    catchupSize: pick('catchupSize', 1, current.catchupSize ?? 1) as number,
    prefCompounds: pick('prefCompounds', true, current.prefCompounds) as boolean,
    prefBase: pick('prefBase', 'contributed', current.prefBase ?? 'contributed') as PrefBase,
    carryRecipients: current.recipients.map(r => ({ lpEntityId: r.lpEntityId, pct: r.pct })),
  }
  if (input.carryRecipients.length > 0) filledFrom.carryRecipients = 'current'
  // Per LP only on European or straight terms; otherwise keep today's scope, and say so.
  const scope = proposal.terms.waterfallScope?.value
  if (scope && (scope === 'fund' || kind === 'european' || kind === 'straight')) input.waterfallScope = scope
  else if (current.waterfallScope === 'per_lp' && (kind === 'european' || kind === 'straight')) {
    input.waterfallScope = 'per_lp'
    filledFrom.waterfallScope = 'current'
  }
  if (kind === 'straight' || kind === 'none') {
    delete filledFrom.prefRate
    delete filledFrom.prefBase
    delete filledFrom.catchupRate
    delete filledFrom.catchupSize
    input.prefRate = 0
    input.catchupRate = 1
    input.catchupSize = 1
    if (kind === 'none') { delete filledFrom.carryRate; input.carryRate = 0 }
  }
  return { input, filledFrom }
}

/** The per-field provenance a staged set_waterfall_terms carries to its approver. */
export function sourcesOf(proposal: LpaTermsProposal): { field: TermField; quote: string; section: string | null; page: number | null; confidence: Confidence; quoteVerified: boolean }[] {
  return TERM_FIELDS.flatMap(f => {
    const p = proposal.terms[f]
    return p ? [{ field: f, quote: p.quote, section: p.section, page: p.page, confidence: p.confidence, quoteVerified: p.quoteVerified }] : []
  })
}
