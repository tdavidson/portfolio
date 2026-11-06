// An entity's letter profile: the fixed facts its letters copy rather than write (lp_letter_profiles).
//
// The fund's template is how its letters read (structure, voice, examples, house rules) and is the
// same for every entity. A profile is what one entity's letters say each time: its names, the
// firm's name, whether it is still investing, the signatories, each company's display name and
// former names, standing footnotes, the parties it names and the paragraphs it repeats. One
// firm-wide profile holds defaults; an entity's own profile fills in or overrides each field.
//
// Pure: no server imports. The store is profile-store.ts.

export interface Signatory { name: string; title: string | null }

export interface CompanyName {
  company_id: string
  /** The name the letter uses for the company. */
  display_name: string | null
  /** Names the company had before, which the letter should no longer use alone. */
  former_names: string[]
  /** A letter-facing status the books can't express, such as "Wound Down". */
  status: string | null
}

export interface FixedText { heading: string; text: string }

/** The entity's id in another system (its fund administrator, say), so an assistant reads the right fund there. Data only. */
export interface ExternalId { system: string; id: string }

export interface LetterProfile {
  legal_name: string | null
  short_name: string | null
  firm_name: string | null
  fund_stage: 'investing' | 'harvesting' | null
  signatories: Signatory[]
  company_names: CompanyName[]
  footnotes: string | null
  parties: string | null
  fixed_text: FixedText[]
  external_ids: ExternalId[]
  template_id: string | null
}

export const EMPTY_PROFILE: LetterProfile = {
  legal_name: null, short_name: null, firm_name: null, fund_stage: null, signatories: [], company_names: [],
  footnotes: null, parties: null, fixed_text: [], external_ids: [], template_id: null,
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** A profile from a request or a stored row: known fields only, trimmed and bounded. Unknown or bad values drop out. */
export function cleanProfile(x: any): LetterProfile {
  const sigs = (Array.isArray(x?.signatories) ? x.signatories : [])
    .map((s: any) => ({ name: str(typeof s === 'string' ? s : s?.name, 200), title: str(s?.title, 200) }))
    .filter((s: any) => s.name)
    .slice(0, 12) as Signatory[]
  const names = (Array.isArray(x?.company_names) ? x.company_names : [])
    .filter((c: any) => c && typeof c.company_id === 'string' && c.company_id)
    .map((c: any) => ({
      company_id: c.company_id.slice(0, 100),
      display_name: str(c.display_name, 200),
      former_names: (Array.isArray(c.former_names) ? c.former_names : []).map((n: unknown) => str(n, 200)).filter(Boolean).slice(0, 10) as string[],
      status: str(c.status, 60),
    }))
    .slice(0, 500) as CompanyName[]
  const fixed = (Array.isArray(x?.fixed_text) ? x.fixed_text : [])
    .map((f: any) => ({ heading: str(f?.heading, 300), text: str(f?.text, 20_000) }))
    .filter((f: any) => f.heading && f.text)
    .slice(0, 30) as FixedText[]
  const ids = (Array.isArray(x?.external_ids) ? x.external_ids : [])
    .map((e: any) => ({ system: str(e?.system, 100), id: str(e?.id, 200) }))
    .filter((e: any) => e.system && e.id)
    .slice(0, 10) as ExternalId[]
  return {
    legal_name: str(x?.legal_name, 300),
    short_name: str(x?.short_name, 200),
    firm_name: str(x?.firm_name, 300),
    fund_stage: x?.fund_stage === 'investing' || x?.fund_stage === 'harvesting' ? x.fund_stage : null,
    signatories: sigs,
    company_names: names,
    footnotes: str(x?.footnotes, 20_000),
    parties: str(x?.parties, 5000),
    fixed_text: fixed,
    external_ids: ids,
    template_id: str(x?.template_id, 100),
  }
}

/** The entity's profile over the firm-wide one: each field the entity sets wins; lists merge by key. */
export function mergeProfiles(firm: LetterProfile | null, own: LetterProfile | null): LetterProfile {
  const a = firm ?? EMPTY_PROFILE
  const b = own ?? EMPTY_PROFILE
  const byCompany = new Map(a.company_names.map(c => [c.company_id, c]))
  for (const c of b.company_names) byCompany.set(c.company_id, c)
  const byHeading = new Map(a.fixed_text.map(f => [f.heading.toLowerCase(), f]))
  for (const f of b.fixed_text) byHeading.set(f.heading.toLowerCase(), f)
  return {
    legal_name: b.legal_name ?? a.legal_name,
    short_name: b.short_name ?? a.short_name,
    firm_name: b.firm_name ?? a.firm_name,
    fund_stage: b.fund_stage ?? a.fund_stage,
    signatories: b.signatories.length ? b.signatories : a.signatories,
    company_names: Array.from(byCompany.values()),
    footnotes: b.footnotes ?? a.footnotes,
    parties: b.parties ?? a.parties,
    fixed_text: Array.from(byHeading.values()),
    external_ids: b.external_ids.length ? b.external_ids : a.external_ids,
    template_id: b.template_id ?? a.template_id,
  }
}

export function isEmptyProfile(p: LetterProfile): boolean {
  return JSON.stringify({ ...p, template_id: null }) === JSON.stringify(EMPTY_PROFILE)
}

/** The profile as a writer layer: plain lines, in the order a letter uses them. */
export function profileAsLayer(p: LetterProfile, companyNameOf: (id: string) => string | undefined = () => undefined): string | null {
  if (isEmptyProfile(p)) return null
  const lines: string[] = []
  if (p.legal_name) lines.push(`Legal name: ${p.legal_name}`)
  if (p.short_name) lines.push(`Short name (after first use): ${p.short_name}`)
  if (p.firm_name) lines.push(`The firm: ${p.firm_name}`)
  if (p.fund_stage) lines.push(`Stage of the fund: ${p.fund_stage === 'investing' ? 'still making new investments' : 'harvesting: no new investments'}`)
  if (p.signatories.length) lines.push(`Signatories, in order: ${p.signatories.map(s => (s.title ? `${s.name}, ${s.title}` : s.name)).join('; ')}`)
  for (const c of p.company_names) {
    const books = companyNameOf(c.company_id)
    const parts = [
      c.display_name ? `call it "${c.display_name}"` : null,
      c.former_names.length ? `formerly ${c.former_names.map(n => `"${n}"`).join(', ')}` : null,
      c.status ? `status: ${c.status}` : null,
    ].filter(Boolean)
    if (parts.length) lines.push(`Company ${books ? `"${books}"` : c.company_id}: ${parts.join('; ')}`)
  }
  if (p.parties) lines.push(`Parties the letter names: ${p.parties}`)
  if (p.footnotes) lines.push(`Standing footnotes:\n${p.footnotes}`)
  for (const e of p.external_ids) lines.push(`Id in ${e.system}: ${e.id}`)
  for (const f of p.fixed_text) lines.push(`Fixed text for "${f.heading}" (copy it unless the facts changed):\n${f.text}`)
  return lines.join('\n')
}

/** Former names a text uses without the company's display name beside them. */
export function formerNamesUsed(text: string, p: LetterProfile): { former: string; display: string }[] {
  const out: { former: string; display: string }[] = []
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const c of p.company_names) {
    if (!c.display_name) continue
    const hasDisplay = new RegExp(`\\b${esc(c.display_name)}\\b`, 'i').test(text)
    for (const f of c.former_names) {
      if (!hasDisplay && new RegExp(`\\b${esc(f)}\\b`, 'i').test(text)) out.push({ former: f, display: c.display_name })
    }
  }
  return out
}
