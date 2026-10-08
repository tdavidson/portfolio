// The schedule of investments' tie-out, as an exception report.
//
// Every derived entry posts when recorded (plans/spec-ledger-one-writer.md §2), so a schedule that
// does not tie is a real disagreement: transactions never put on the ledger (the backfill puts them
// there), or an entry edited by hand after it was booked.
export type TieOutState = 'booked' | 'disagrees'

export function tieOutState({ tied }: { tied: boolean }): TieOutState {
  return tied ? 'booked' : 'disagrees'
}
