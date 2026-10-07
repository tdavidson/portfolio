import { describe, it, expect } from 'vitest'
import { entityGrantProblem } from './entity-grants'

describe('entityGrantProblem — granting a member an entity', () => {
  const member = { user_id: 'u2', role: 'member' }
  const vehicle = { id: 'v1', fund_id: 'f1' }

  it('accepts a member and an entity of this fund', () => {
    expect(entityGrantProblem({ fundId: 'f1', target: member, vehicle, granted: true })).toBeNull()
  })

  it('refuses someone who is not a member here', () => {
    expect(entityGrantProblem({ fundId: 'f1', target: null, vehicle, granted: true })).toMatchObject({ status: 404 })
  })

  it('refuses an entity of another fund, as not found', () => {
    expect(entityGrantProblem({ fundId: 'f1', target: member, vehicle: { id: 'v9', fund_id: 'f2' }, granted: true })).toMatchObject({ status: 404 })
    expect(entityGrantProblem({ fundId: 'f1', target: member, vehicle: null, granted: true })).toMatchObject({ status: 404 })
  })

  it('refuses granting an admin — they see every entity already, and a row would mislead', () => {
    expect(entityGrantProblem({ fundId: 'f1', target: { user_id: 'u1', role: 'admin' }, vehicle, granted: true })).toMatchObject({ status: 400 })
  })

  it('requires a yes or no', () => {
    expect(entityGrantProblem({ fundId: 'f1', target: member, vehicle, granted: 'yes' as any })).toMatchObject({ status: 400 })
  })
})
