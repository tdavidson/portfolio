import { describe, it, expect } from 'vitest'
import { escrowReceiptError } from './proceeds'
import { RECORDABLE_TXN_TYPES, PORTFOLIO_TOOL_MANIFEST } from '@/lib/agent/portfolio-tools-manifest'
import { TRANSACTION_TYPES } from './transaction-checks'

describe('escrowReceiptError', () => {
  it('accepts cash released from escrow, with no cost and no escrow of its own', () => {
    expect(escrowReceiptError({ transaction_type: 'escrow_receipt', proceeds_received: 25_000 })).toBeNull()
  })
  it('needs an amount received', () => {
    expect(escrowReceiptError({ transaction_type: 'escrow_receipt', proceeds_received: 0 })).toMatch(/proceeds_received/)
  })
  it('refuses a receipt that moves cost', () => {
    expect(escrowReceiptError({ transaction_type: 'escrow_receipt', proceeds_received: 25_000, cost_basis_exited: 10_000 })).toMatch(/moves no cost/)
  })
  it('refuses a receipt that holds escrow', () => {
    expect(escrowReceiptError({ transaction_type: 'escrow_receipt', proceeds_received: 25_000, proceeds_escrow: 5_000 })).toMatch(/holds none/)
  })
  it('ignores other row types', () => {
    expect(escrowReceiptError({ transaction_type: 'proceeds', proceeds_received: 0 })).toBeNull()
  })
})

describe('agent tools can record an escrow receipt', () => {
  it('record_investment and update_investment offer escrow_receipt', () => {
    expect(RECORDABLE_TXN_TYPES).toContain('escrow_receipt')
    for (const name of ['record_investment', 'update_investment']) {
      const tool = PORTFOLIO_TOOL_MANIFEST.find((t: any) => t.name === name) as any
      expect(tool.inputSchema.properties.transaction_type.enum).toContain('escrow_receipt')
    }
  })
  it('every type the tools offer is one the edit path and the database accept', () => {
    for (const t of RECORDABLE_TXN_TYPES) expect(TRANSACTION_TYPES).toContain(t)
  })
})
