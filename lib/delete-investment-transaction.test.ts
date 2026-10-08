import { describe, expect, it } from 'vitest'
import { deleteInvestmentTransaction } from './delete-investment-transaction'

const res = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('deleteInvestmentTransaction', () => {
  it('surfaces the server error text instead of doing nothing', async () => {
    const msg = 'Edit it from the fund register.'
    expect(await deleteInvestmentTransaction('c', 't', res(409, { error: msg }))).toEqual({ ok: false, error: msg })
  })
  it('falls back to a generic message and reports success', async () => {
    expect(await deleteInvestmentTransaction('c', 't', res(500, 'x'))).toEqual({ ok: false, error: 'Failed to delete transaction' })
    expect(await deleteInvestmentTransaction('c', 't', (async () => { throw new Error('net') }) as any)).toMatchObject({ ok: false })
    expect(await deleteInvestmentTransaction('c', 't', res(200, {}))).toEqual({ ok: true })
  })
})
