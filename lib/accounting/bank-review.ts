// A bank row HELD for a person's decision, and why: a possible QuickBooks duplicate
// (bank-quickbooks-match.ts), or more than one posted investment entry it could be
// (investment-bank-match.ts). The flag stays set after the row is linked, marking what it was
// linked to — so "under review" is the flag, and "awaiting the decision" is the flag plus status
// 'unmatched'. Every guard that refuses to book a second entry for such a row asks this.

export type ReviewKind = 'quickbooks' | 'investment'

export function reviewKind(raw: any): ReviewKind | null {
  if (raw?.investmentReview) return 'investment'
  if (raw?.quickbooksReview) return 'quickbooks'
  return null
}

export const underReview = (raw: any): boolean => reviewKind(raw) !== null
