import type { SupabaseClient } from '@supabase/supabase-js'

// Per-vehicle letterhead: logo, name, address and email (fund_vehicles.logo_url, letterhead_name,
// letterhead_address — 20261012120000_vehicle_letterhead.sql — and letterhead_email, with the fund's
// default in funds.contact_email — 20261013160000_letterhead_email.sql).
//
// A firm can administer a vehicle that has its own brand: Northwind Holdings is run from this fund's
// books, but its LPs know it as Northwind, not as the firm. So an LP-facing PDF about ONE vehicle (a
// capital account statement, a call or distribution notice, a receipt, a letter) carries that
// vehicle's letterhead where it has one, and the fund's otherwise. A document spanning several
// vehicles (an investor report) uses a vehicle's value only when every vehicle on it shares it: an
// LP who is only in Northwind vehicles gets Northwind's letterhead, one also in the flagship gets the fund's.
//
// Each of the four parts falls back on its own, so a vehicle with only a logo set still prints
// the fund's name, address and email.
//
// Logos are data URIs only: a remote URL silently fails to render inside headless Chrome, which is
// the same constraint the fund logo carries.

export interface Letterhead {
  logo: string | null
  name: string
  address: string | null
  email: string | null
}

export interface VehicleLetterhead {
  logo: string | null
  name: string | null
  address: string | null
  email: string | null
}

// A base64 image data URI and nothing else. Every PDF template interpolates the logo straight into
// `<img src="…">`, so a prefix check alone let a value like `data:image/png"><iframe src=…>` inject
// markup into the server's headless Chromium. The upload UI always produces base64 (readAsDataURL).
const LOGO_DATA_URI = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/i

export function isSafeLogoDataUri(v: unknown): v is string {
  return typeof v === 'string' && LOGO_DATA_URI.test(v)
}

export function safeLogo(v: unknown): string | null {
  return isSafeLogoDataUri(v) ? v : null
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

type FundRow = { name?: unknown; logo_url?: unknown; address?: unknown; contact_email?: unknown } | null | undefined

/** The fund's own letterhead, from a `funds` row (name, logo_url, address, contact_email). */
export function fundLetterhead(fund: FundRow): Letterhead {
  return { logo: safeLogo(fund?.logo_url), name: text(fund?.name) ?? '', address: text(fund?.address), email: text(fund?.contact_email) }
}

/**
 * The address block a document prints under the letterhead name: the address, then the email on a
 * line of its own. Null when neither is set.
 */
export function contactBlock(lh: { address: string | null; email: string | null }): string | null {
  const lines = [lh.address, lh.email].filter((v): v is string => !!v)
  return lines.length > 0 ? lines.join('\n') : null
}

/**
 * The fund's default letterhead email. Read on its own rather than added to every caller's `funds`
 * select, because the column may not be migrated yet (20261013160000_letterhead_email.sql) and a
 * select naming it would then fail the whole row.
 */
export async function loadFundEmail(admin: SupabaseClient, fundId: string): Promise<string | null> {
  const { data, error } = await (admin as any).from('funds').select('contact_email').eq('id', fundId).maybeSingle()
  if (error) return null
  return text((data as any)?.contact_email)
}

/**
 * Vehicle name (and every alias) → letterhead, for the vehicles in this fund that set any part of
 * one. Empty when the columns are not migrated yet, so every caller degrades to the fund's.
 */
export async function loadVehicleLetterheads(admin: SupabaseClient, fundId: string): Promise<Map<string, VehicleLetterhead>> {
  const out = new Map<string, VehicleLetterhead>()
  let res = await (admin as any)
    .from('fund_vehicles')
    .select('name, aliases, logo_url, letterhead_name, letterhead_address, letterhead_email')
    .eq('fund_id', fundId)
    .or('logo_url.not.is.null,letterhead_name.not.is.null,letterhead_address.not.is.null,letterhead_email.not.is.null')
  // letterhead_email not migrated yet: the other three parts still apply.
  if (res.error) {
    res = await (admin as any)
      .from('fund_vehicles')
      .select('name, aliases, logo_url, letterhead_name, letterhead_address')
      .eq('fund_id', fundId)
      .or('logo_url.not.is.null,letterhead_name.not.is.null,letterhead_address.not.is.null')
  }
  const { data, error } = res
  if (error) return out
  for (const v of (data as any[]) ?? []) {
    const lh: VehicleLetterhead = {
      logo: safeLogo(v.logo_url), name: text(v.letterhead_name), address: text(v.letterhead_address), email: text(v.letterhead_email),
    }
    if (!lh.logo && !lh.name && !lh.address && !lh.email) continue
    out.set(v.name, lh)
    for (const a of (v.aliases as string[] | null) ?? []) if (!out.has(a)) out.set(a, lh)
  }
  return out
}

/** The value every vehicle shares, or null when any lacks it or they differ. */
function shared(values: (string | null)[]): string | null {
  if (values.length === 0) return null
  return values.every(v => v !== null && v === values[0]) ? values[0] : null
}

/** The letterhead for a document covering `groups`: per part, the vehicles' shared value, else the fund's. */
export function pickLetterhead(fund: Letterhead, groups: string[], vehicles: Map<string, VehicleLetterhead>): Letterhead {
  const distinct = Array.from(new Set(groups.filter(Boolean)))
  const parts = distinct.map(g => vehicles.get(g))
  return {
    logo: shared(parts.map(p => p?.logo ?? null)) ?? fund.logo,
    name: shared(parts.map(p => p?.name ?? null)) ?? fund.name,
    address: shared(parts.map(p => p?.address ?? null)) ?? fund.address,
    email: shared(parts.map(p => p?.email ?? null)) ?? fund.email,
  }
}

/** Convenience for a single document. */
export async function documentLetterhead(
  admin: SupabaseClient, fundId: string,
  fund: FundRow,
  groups: string[],
): Promise<Letterhead> {
  const [email, vehicles] = await Promise.all([
    fund?.contact_email !== undefined ? Promise.resolve(text(fund.contact_email)) : loadFundEmail(admin, fundId),
    loadVehicleLetterheads(admin, fundId),
  ])
  return pickLetterhead({ ...fundLetterhead(fund), email }, groups, vehicles)
}

/**
 * One vehicle's letterhead as a document about it prints it, alongside the fund's default and the
 * vehicle's own overrides, so a screen can show which parts come from where.
 */
export async function vehicleLetterheadDetail(admin: SupabaseClient, fundId: string, group: string): Promise<{
  letterhead: Letterhead
  fund: Letterhead
  vehicle: VehicleLetterhead
}> {
  const [fundRes, email, vehicles] = await Promise.all([
    (admin as any).from('funds').select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    loadFundEmail(admin, fundId),
    loadVehicleLetterheads(admin, fundId),
  ])
  const fund = { ...fundLetterhead(fundRes.data), email }
  return {
    letterhead: pickLetterhead(fund, [group], vehicles),
    fund,
    vehicle: vehicles.get(group) ?? { logo: null, name: null, address: null, email: null },
  }
}
