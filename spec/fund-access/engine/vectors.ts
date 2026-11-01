// Load every vector under spec/fund-access/vectors. Used by the reference run and by an
// implementation's adapter test alike.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Call, Fund, Outcome, Party, Reason } from './decide'

export interface Vector {
  id: string
  fundAccess: '0.1'
  title: string
  description?: string
  tags: string[]
  fund: Fund
  party: Party
  call: Call
  expect: { outcome: Outcome; reason?: Reason }
}

export const VECTOR_DIR = join(__dirname, '..', 'vectors')

export function loadVectors(dir = VECTOR_DIR): Vector[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => readdirSync(join(dir, d.name)).filter(f => f.endsWith('.json')).map(f => join(dir, d.name, f)))
    .sort()
    .map(p => JSON.parse(readFileSync(p, 'utf8')) as Vector)
}
