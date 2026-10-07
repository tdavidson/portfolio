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
