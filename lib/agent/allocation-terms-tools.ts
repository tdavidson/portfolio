// Handlers for the ALLOCATION TERMS tools (allocation-terms-tools-manifest.ts).

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { hasAccess } from '@/lib/access/effective'
import { loadEntityNames } from '@/lib/accounting/load'
import {
  loadAllocationBasis, saveAllocationBasis, loadPartnerTerms, savePartnerTerm, loadResolvedCommitments,
  type AllocationBasis, type AllocationCategory,
} from '@/lib/accounting/terms'
import { resolvePartner } from '@/lib/agent/gp-link-tools'
import { ALLOCATION_CATEGORIES } from '@/lib/agent/allocation-terms-tools-manifest'

const isCategory = (c: unknown): c is AllocationCategory => typeof c === 'string' && (ALLOCATION_CATEGORIES as readonly string[]).includes(c)
const optionalNumber = (v: unknown, what: string): number | null | undefined => {
  if (v === undefined) return undefined
  if (v === null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a number of 0 or more, or null.`)
  return n
}

export const ALLOCATION_TERMS_HANDLERS: Record<string, AgentToolHandler> = {
  allocation_terms: async ({ admin, fundId, portfolioGroup, access }: AgentToolContext, input: any) => {
    const only = input?.category
    if (only !== undefined && !isCategory(only)) throw new Error(`Unknown category ${only}.`)
    const canReadCarry = hasAccess(access, 'gp_economics', 'read')
    if (only === 'carried_interest' && !canReadCarry) throw new Error('Carried-interest terms need GP economics read access.')
    const [basis, terms, names, commitments] = await Promise.all([
      loadAllocationBasis(admin, fundId, portfolioGroup),
      loadPartnerTerms(admin, fundId, portfolioGroup),
      loadEntityNames(admin, fundId, portfolioGroup),
      loadResolvedCommitments(admin, fundId, portfolioGroup),
    ])
    const partners = Array.from(names.entries())
      .map(([id, name]) => ({
        id,
        name,
        commitment: commitments.get(id) ?? 0,
        terms: terms
          .filter(t => t.lpEntityId === id && (only ? t.category === only : true) && (canReadCarry || t.category !== 'carried_interest'))
          .map(t => ({ category: t.category, participates: t.participates, weight: t.weightOverride, rate: t.rateOverride })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { vehicle: portfolioGroup, basis, partners, ...(canReadCarry ? {} : { note: 'Carried-interest terms are hidden: they need GP economics read access.' }) }
  },

  set_allocation_terms: async ({ admin, fundId, portfolioGroup, access }: AgentToolContext, input: any) => {
    const basis = input?.basis as AllocationBasis | undefined
    const list: any[] = Array.isArray(input?.terms) ? input.terms : []
    if (!basis && list.length === 0) throw new Error('Pass terms (with a category), basis, or both.')
    if (basis !== undefined && basis !== 'commitment' && basis !== 'capital_balance') throw new Error('basis must be commitment or capital_balance.')

    // Resolve and check every term before writing any, so a bad partner name changes nothing.
    let category: AllocationCategory | null = null
    const resolved: { lpEntityId: string; name: string; participates: boolean; weight: number | null; rate: number | null; memo: string | null }[] = []
    if (list.length > 0) {
      if (!isCategory(input?.category)) throw new Error('category is required with terms, and must be one of ' + ALLOCATION_CATEGORIES.join(', ') + '.')
      category = input.category
      if (category === 'carried_interest' && !hasAccess(access, 'gp_economics', 'write')) {
        throw new Error('Carried-interest terms need GP economics write access.')
      }
      const partners = await loadEntityNames(admin, fundId, portfolioGroup)
      const existing = await loadPartnerTerms(admin, fundId, portfolioGroup)
      const missing: string[] = []
      const seen = new Set<string>()
      for (const t of list) {
        const ref = String(t?.partner ?? '').trim()
        const id = ref ? resolvePartner(partners, ref) : null
        if (!id) { missing.push(ref || '(blank)'); continue }
        if (seen.has(id)) throw new Error(`${ref} is named twice.`)
        seen.add(id)
        // An omitted field keeps what the term holds today; null clears it.
        const today = existing.find(e => e.lpEntityId === id && e.category === category)
        const weight = optionalNumber(t?.weight, `${ref}'s weight`)
        const rate = optionalNumber(t?.rate, `${ref}'s rate`)
        resolved.push({
          lpEntityId: id,
          name: partners.get(id) ?? ref,
          participates: t?.participates === undefined ? (today?.participates ?? true) : t.participates !== false,
          weight: weight === undefined ? (today?.weightOverride ?? null) : weight,
          rate: rate === undefined ? (today?.rateOverride ?? null) : rate,
          memo: t?.memo == null ? null : String(t.memo),
        })
      }
      if (missing.length > 0) {
        throw new Error(
          `Not partners of ${portfolioGroup}: ${missing.join(', ')}. Nothing was changed. Partners: ` +
          (Array.from(partners.values()).join(', ') || 'none') + '. Add a missing one with add_partner first.',
        )
      }
    }

    if (basis) {
      const r = await saveAllocationBasis(admin, fundId, portfolioGroup, basis)
      if ('error' in r) throw new Error(r.error)
    }
    for (const t of resolved) {
      const r = await savePartnerTerm(admin, fundId, portfolioGroup, {
        lpEntityId: t.lpEntityId, category: category!, participates: t.participates,
        weightOverride: t.weight, rateOverride: t.rate, memo: t.memo,
      })
      if ('error' in r) throw new Error(`${t.name}: ${r.error}`)
    }
    return {
      vehicle: portfolioGroup,
      ...(basis ? { basis } : {}),
      ...(category ? { category, terms: resolved.map(t => ({ partner: t.name, participates: t.participates, weight: t.weight, rate: t.rate })) } : {}),
    }
  },
}
