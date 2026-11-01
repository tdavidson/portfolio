import { describe, it, expect } from 'vitest'
import { selfApprovalRefused } from './service'

const row = (created_credential: string | null, created_via = 'mcp') => ({ created_by: 'u', created_via, created_credential })

describe('selfApprovalRefused — who may approve what they staged', () => {
  it('a chat may approve its own change, on its person\'s word in the conversation', () => {
    expect(selfApprovalRefused({ userId: 'u', credentialId: 'oauth:c1' }, row('oauth:c1'))).toBe(false)
  })

  it('a program on /api/v1 may not, whether it staged over /api/v1 or the same client staged over MCP', () => {
    expect(selfApprovalRefused({ userId: 'u', credentialId: 'v1:c1' }, row('v1:c1', 'api'))).toBe(true)
    expect(selfApprovalRefused({ userId: 'u', credentialId: 'v1:c1' }, row('oauth:c1'))).toBe(true)
  })

  it('a script\'s key may not, and another credential of the same person may', () => {
    expect(selfApprovalRefused({ userId: 'u', credentialId: 'key-1' }, row('key-1', 'api'))).toBe(true)
    expect(selfApprovalRefused({ userId: 'u', credentialId: 'v1:c2' }, row('oauth:c1'))).toBe(false)
  })
})
