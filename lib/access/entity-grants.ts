// Granting a member an entity (fund_member_vehicles). The settings API validates with this before
// writing; it is pure so the rules are tested without a database.

export interface GrantProblem { status: number; error: string }

export function entityGrantProblem(args: {
  fundId: string
  target: { user_id: string; role: string } | null
  vehicle: { id: string; fund_id: string } | null
  granted: unknown
}): GrantProblem | null {
  if (typeof args.granted !== 'boolean') return { status: 400, error: 'granted must be true or false' }
  if (!args.target) return { status: 404, error: 'Not a member of this fund' }
  // Not found rather than "wrong fund": the id should mean nothing to someone outside it.
  if (!args.vehicle || args.vehicle.fund_id !== args.fundId) return { status: 404, error: 'Entity not found' }
  if (args.target.role === 'admin') return { status: 400, error: 'Admins see every entity. Grants apply to members.' }
  return null
}

/**
 * The explicit "All entities" grant (fund_members.all_entities): everything, including entities
 * created later and rows assigned to none. A stored choice, never inferred from holding every grant
 * row — inferring it made creating an entity silently narrow every such member.
 */
export function allEntitiesProblem(args: {
  target: { user_id: string; role: string } | null
  allEntities: unknown
}): GrantProblem | null {
  if (typeof args.allEntities !== 'boolean') return { status: 400, error: 'allEntities must be true or false' }
  if (!args.target) return { status: 404, error: 'Not a member of this fund' }
  if (args.target.role === 'admin') return { status: 400, error: 'Admins see every entity. Grants apply to members.' }
  return null
}

/**
 * What a member sees, chosen when an admin approves them: All entities, or at least one of the
 * fund's. Required — a member approved with nothing lands on empty pages.
 */
export function parseApprovalEntities(
  raw: unknown,
  fundVehicleIds: string[],
): { all: boolean; ids: string[] } | { error: string } {
  const v = (raw ?? {}) as { all?: unknown; ids?: unknown }
  if (v.all === true) return { all: true, ids: [] }
  const ids = Array.isArray(v.ids) ? Array.from(new Set(v.ids.map(String))) : []
  if (ids.length === 0) return { error: 'Choose which entities this member can see, or All entities.' }
  if (ids.some(id => !fundVehicleIds.includes(id))) return { error: 'Entity not found' }
  return { all: false, ids }
}
