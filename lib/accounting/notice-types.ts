// What a notice PDF is rendered from. Apart from notice-pdf.ts so code that only assembles or
// previews a notice's figures can name these types without reaching headless Chromium
// (lib/pdf-routes.mjs lists the routes that may).

export type NoticeKind = 'capital_call' | 'distribution'

export interface NoticeData {
  kind: NoticeKind
  /** Fund's display face (FundTheme.displayFont). Absent = the default. */
  displayFont?: string | null
  fundName: string
  fundLogo: string | null
  fundAddress: string | null
  currency: string
  vehicle: string
  partnerName: string
  /** Date of the call or declaration — NOT today. A reissued PDF must not move it. */
  noticeDate: string
  /** Sequence within the vehicle, when the register carries one. */
  number?: number | null
  description?: string | null
  /** THE figure. Straight from the register line, frozen at issue. */
  amount: number
  /** Calls only: when the money is due. */
  dueDate?: string | null
  /** Calls only: where to send it. */
  wireInstructions?: string | null
  /**
   * Context lines shown under the amount — commitment, called to date, remaining, or capital
   * balance. Supplied by the caller as label/value pairs so the register stays the only
   * source of the amount itself.
   */
  context?: { label: string; value: number | null }[]
  /**
   * Calls only: what the WHOLE call is for, fund-wide, as frozen at issue. Shown with the
   * partner's share rather than split per partner, so no rounding makes the parts disagree with
   * the amount above.
   */
  purposes?: { label: string; amount: number; basis?: string | null }[] | null
  /**
   * Distributions: what the amount is made of, each a separate figure that adds to it. The GP's
   * notice shows the distribution on its own capital investment and its carried interest apart.
   */
  components?: { label: string; amount: number; detail?: { label: string; value: number }[] }[] | null
  /** The partner's share of the vehicle's commitments, 0..1, shown beside the purposes. */
  share?: number | null
  /** A preview: marked DRAFT on every page, so it can never pass for a demand. */
  draft?: boolean
}
