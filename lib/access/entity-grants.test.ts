import { describe, it, expect } from 'vitest'
import { allEntitiesProblem, entityGrantProblem, parseApprovalEntities } from './entity-grants'

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


describe('allEntitiesProblem — the explicit "All entities" grant', () => {
  it('is set on members only, as a boolean', () => {
    expect(allEntitiesProblem({ target: { user_id: 'u', role: 'member' }, allEntities: true })).toBeNull()
    expect(allEntitiesProblem({ target: { user_id: 'u', role: 'member' }, allEntities: 'yes' })).toMatchObject({ status: 400 })
    expect(allEntitiesProblem({ target: null, allEntities: true })).toMatchObject({ status: 404 })
    expect(allEntitiesProblem({ target: { user_id: 'u', role: 'admin' }, allEntities: false })).toMatchObject({ status: 400 })
  })
})

describe('parseApprovalEntities — approving a member chooses what they see', () => {
  const fund = ['v1', 'v2']
  it('accepts All, or a non-empty list of the fund\'s entities', () => {
    expect(parseApprovalEntities({ all: true }, fund)).toEqual({ all: true, ids: [] })
    expect(parseApprovalEntities({ ids: ['v2', 'v2'] }, fund)).toEqual({ all: false, ids: ['v2'] })
  })
  it('refuses no choice, an empty list, or another fund\'s entity', () => {
    expect(parseApprovalEntities(undefined, fund)).toMatchObject({ error: expect.stringMatching(/Choose/) })
    expect(parseApprovalEntities({ ids: [] }, fund)).toMatchObject({ error: expect.stringMatching(/Choose/) })
    expect(parseApprovalEntities({ ids: ['v9'] }, fund)).toMatchObject({ error: expect.stringMatching(/not found/) })
  })
})
