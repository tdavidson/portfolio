// Completeness: every partner the app knows in the vehicle is in the package, and nothing the app
// doesn't know is.
//
//   - a package partner matched to no app partner is flagged (a warning: it may be new, or named
//     differently), never dropped
//   - two package partners matched to the same app partner is an error
//   - an app partner missing from the package is an error
//
// Holdings join this check when the schedule of investments comparison arrives (stage 2).

import type { Finding } from '../types'
import { partnerSubject, type Check } from './shared'

export const completeness: Check = ({ pkg, known, matches }) => {
  const findings: Finding[] = []
  const partners = pkg.partners ?? []
  if (!partners.length) {
    return { outcome: { check: 'completeness', ran: false, compared: 0, note: 'The package has no partner capital accounts.' }, findings }
  }
  const cite = (i: number) => {
    const c = partners[i].cite
    return c ? Object.values(c).slice(0, 1) : []
  }

  let compared = 0
  const seen = new Map<string, number[]>()
  partners.forEach((p, i) => {
    compared++
    const id = p.lpEntityId ?? matches?.[i]?.lpEntityId ?? null
    if (!id) {
      findings.push({
        check: 'completeness', severity: 'warning', subject: partnerSubject(p),
        message: `${p.name} isn't a partner the app knows in this vehicle; add them, or match them to the right partner.`,
        cites: cite(i), status: 'open',
      })
      return
    }
    seen.set(id, [...(seen.get(id) ?? []), i])
  })
  for (const [id, idx] of Array.from(seen.entries())) {
    if (idx.length < 2) continue
    findings.push({
      check: 'completeness', severity: 'error', subject: { kind: 'partner', id, label: partners[idx[0]].name },
      message: `${idx.map(i => partners[i].name).join(' and ')} are the same partner in the app; the package lists them ${idx.length} times.`,
      cites: idx.flatMap(cite), status: 'open',
    })
  }

  if (known == null) {
    return {
      outcome: { check: 'completeness', ran: true, compared, note: "The app's own partner list for the vehicle couldn't be read, so only the package's partners were checked." },
      findings,
    }
  }
  for (const k of known) {
    compared++
    if (seen.has(k.lpEntityId)) continue
    findings.push({
      check: 'completeness', severity: 'error', subject: { kind: 'partner', id: k.lpEntityId, label: k.name },
      message: `${k.name} is a partner in this vehicle but isn't in the package.`,
      cites: [], status: 'open',
    })
  }
  return { outcome: { check: 'completeness', ran: true, compared }, findings }
}
