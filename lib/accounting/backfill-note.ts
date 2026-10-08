// The firm index's "book all" note: what the all-vehicles backfill left for a person. Both lists
// count — a company carried by both the tracker and the journal is booked by neither side.

export interface BookAllVehicle { result?: { refused?: string[]; conflicted?: string[] } }

export function bookAllNote(vehicles: BookAllVehicle[]): string | null {
  const sum = (key: 'refused' | 'conflicted') => vehicles.reduce((n, v) => n + (v.result?.[key]?.length ?? 0), 0)
  const refused = sum('refused')
  const conflicted = sum('conflicted')
  const parts: string[] = []
  if (refused > 0) parts.push(`${refused} could not be booked`)
  if (conflicted > 0) parts.push(`${conflicted} ${conflicted === 1 ? 'is' : 'are'} carried by both the tracker and the journal`)
  return parts.length ? `${parts.join(', ')} — see each entity’s status page.` : null
}
