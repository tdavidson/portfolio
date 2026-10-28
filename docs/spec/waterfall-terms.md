# Waterfall terms: specification

Spec version 2. This document sets out every economic term the accounting engine supports today,
how each one is computed, and what the engine does **not** model yet. It is written from the code,
and the code backs it up. `docs/spec/waterfall-vectors.json` holds machine-readable test vectors.
`lib/accounting/waterfall-spec.test.ts` runs every one of those vectors through the engine, so a
change to the engine that breaks the spec fails the test suite.

The math lives in the open fund engine, `packages/fund-engine` (`@portfolio/fund-engine`). The
`lib/accounting` modules of the same names re-export it.

| Concern | Code |
|---|---|
| Tier order and formulas | `waterfall.ts` (`runWaterfall`) |
| The hurdle | `hurdle.ts` (`preferredTarget`) |
| Replaying prior distributions | `replay.ts` (`replayWaterfallState`) |
| Stored terms, close accrual | `carry.ts` (`VehicleCarryTerms`, `carryTarget`, `carryAccrual`) |
| The close's inputs from the books | `economics.ts` (`carryAccrualInputs`) |
| Splitting a distribution | `distribution-waterfall.ts` (`splitDistribution`) |
| Deal-by-deal capital base and entitlement | `american-carry.ts` (`realizedCapitalFromDeals`, `dealByDealCarry`); rows read by `lib/accounting/realized-capital.ts` |
| Validating and storing terms | `lib/accounting/waterfall-terms.ts` (`parseWaterfallTermsInput`, `saveWaterfallTerms`) |
| Allocation basis | `lib/accounting/terms.ts` (`AllocationBasis`, `allocationWeights`) |

## 1. Conventions

- **Rates are fractions.** `0.2` means 20%. Money is in the vehicle's currency units.
- **Rounding.** Every money result is rounded to cents with `round(x) = Math.round((x + ε) × 100) / 100`,
  where ε is `Number.EPSILON`. The waterfall rounds after every tier (§3.2). A pro-rata split
  into lines uses largest-remainder cents (`apportionCents`), so the lines add up exactly to the
  total.
- **Dates** are ISO `YYYY-MM-DD`, parsed as UTC midnight.

## 2. The terms (one row per vehicle)

The terms are stored in `vehicle_waterfall_terms`, one row per `(fund_id, vehicle_id)`. When a
vehicle has no row, its terms are `NO_CARRY`. That default is deliberate: accruing carry nobody
agreed to is worse than accruing none.

| Field (engine) | Column | Type / range | Default | Meaning |
|---|---|---|---|---|
| `kind` | `kind` | `none` \| `straight` \| `american` \| `european` | `none` | Which waterfall applies (§4). |
| `carryRate` | `carry_rate` | 0 ≤ r < 1 | 0 | The GP's share of profits. |
| `prefRate` | `pref_rate` | 0 ≤ r < 1 | 0 | Annual preferred return (hurdle). Ignored by `straight`. |
| `prefCompounds` | `pref_compounds` | boolean | true | Hurdle compounds annually (true) or accrues simply (false). |
| `prefBase` | `pref_base` | `contributed` \| `unreturned` | `contributed` | What the hurdle accrues on (§5). |
| `catchupRate` | `catchup_rate` | 0 ≤ k ≤ 1 | 1 | The catch-up RATE: the GP's share of each dollar while it catches up; the LPs get the rest. 0 = no catch-up. Ignored by `straight`. |
| `catchupSize` | `catchup_size` | 0 ≤ s ≤ 1 | 1 | The catch-up SIZE: how much of a full catch-up the GP gets (§3.2). 1 = full. Ignored by `straight`. |
| `catchupMeasure` | `catchup_measure` | `preferred` \| `profit` | `preferred` | What the catch-up is measured on (§3.2). They differ only when the catch-up rate is below 1. |
| `prefMultiple` | `pref_multiple` | 1 ≤ m ≤ 10, or null | null | A hurdle set as a multiple of the capital owed, instead of `prefRate` (§5). |
| `prefDayCount` | `pref_day_count` | `act/365` \| `30/360` | `act/365` | How the rate's years are counted (§5). |
| `carrySteps` | `carry_steps` (jsonb `[{lpMultiple \| lpIrr, carryRate, catchUpRate?}]`) | rates rise; thresholds rise | null | Where the carry steps up (§3.3). Null: one carry rate. |
| `capitalIncludes` | `capital_includes` (text[]) | any of `investments`, `fees`, `expenses`, `other`; must include `investments` | null (all four) | What the first tier returns as capital and the hurdle accrues on (§5.1). |
| `gpCommitBearsCarry` | `gp_commit_bears_carry` (boolean) | | false | The recipients' own commitments (the GP commit) bear carry like an LP's (§6, step 3). |
| `recipients` | `carry_recipients` (jsonb `[{lpEntityId, pct}]`) | pct > 0, total 100 ± 0.01 | `[]` | Who receives the carry, and in what split. |
| `gpEntityId` | `gp_entity_id` | partner id or null | null | Legacy single recipient. Used as `[{gpEntityId, 100}]` when `carry_recipients` is empty. |

Validation (`parseWaterfallTermsInput`, shared by the settings page and `set_waterfall_terms`):
- `kind` must be one of the four values.
- Each rate must be in its range.
- Any catch-up rate in range works, including one at or below the carry rate (10% on 20% carry).
- `catchupSize` must be between 0 and 1. Omitted, it is 1.
- `prefBase` must be `contributed` or `unreturned`. Omitted, it is `contributed`.
- `prefMultiple`, when given, is between 1 and 10. `prefDayCount` is `act/365` or `30/360`.
- `catchupMeasure` is `preferred` or `profit`. Measured on profit, the catch-up rate must be above
  the share of profit the GP catches up to, or the catch-up would never finish.
- Each carry step starts at an LP multiple or an LP IRR, not both. Each one raises the carry rate,
  and the multiples or IRRs rise from one step to the next. A catch-up at a step gives the GP more
  of each dollar than the new rate.
- `capitalIncludes` must include `investments`. Omitted, every contribution is capital.
- When carry is on (`kind ≠ none` and `carryRate > 0`), there must be at least one recipient.
- Recipient percentages must total 100.
- Every recipient must be a partner (`lp_entities`) of the same fund.

When there is exactly one recipient, the store writes it to `gp_entity_id` as well.

**Who pays carry.** Carry recipients are outside the LP economics everywhere. They receive carry
and do not pay it. Their own contributions are excluded from the hurdle, and a split warns when a
recipient has also contributed capital. `gpCommitBearsCarry` is the exception, for an LPA that
charges carry on the GP commit too: a distribution's split then runs the recipients' capital
through the tiers with the LPs' (§6), and its contributions are in the hurdle. The close's carry
accrual then measures the whole fund's carry, recipients' capital included. Every partner in
profit bears a share of it by profit, a recipient too, and each recipient receives its percent of
it. One accrual posts both sides to a recipient's capital line, so the line is the net of the two,
and the entry's lines balance without a separate credit. A single recipient at 100% therefore posts
only the carry the LPs bear, because what it pays itself nets out. The books can't split that net
line back into its two halves, and the true-up doesn't need them to: it compares each recipient's
net target with its net accrued (`carryAccrualInputs`, `carryAccrual` in the fund engine). The
statements report, the tax book's carry on unrealized gains and the ILPA earned-carry share follow
the same rule. The forecast runs the whole fund through the waterfall, so the GP's stake comes back
net of the carry it bears, and a GP entity's share of the fund's forecast does too.

**Management fee is not a waterfall term.** The fee is booked by the `management_fee` allocation,
either from a typed rate on commitments (`annualRate` × `periodFraction`, `lib/accounting/fees.ts`)
or, with `fromSchedule`, from the vehicle's dated fee schedule (`vehicle_accounting_settings.
fee_schedule`, `lib/accounting/fee-schedule.ts`): calendar periods, rates that start on a date and
cut the period they land in, bases of commitments, invested capital or NAV, an organizational
expense cap, and offsets: the share of each kind of portfolio-company fee (transaction,
monitoring, directors', other) that credits the fee. Those fees are paid to the GP or the
management company, so they aren't in the fund's books; they're recorded in
`portfolio_company_fees` (`lib/accounting/portfolio-fees.ts`), and an offset larger than its
period's fee carries into the next. The forecast plan has its own `management_fee` rule. Neither is stored with these
terms. `extract_lpa_terms` reports the LPA's fee rate and basis as information
only. `set_waterfall_terms` does not write them.

**Allocation basis is not a waterfall term either.** `vehicle_accounting_settings.allocation_basis`
(`commitment`, the default, or `capital_balance`) decides how the close splits P&L categories
across partners. `partner_allocation_terms` can override a partner's weight, rate or participation
per category. For a GP or associate entity, the `carried_interest` category's weight overrides are
the members' carry points.

## 3. The waterfall (`runWaterfall`)

### 3.1 Inputs

```
terms  = { carryRate c, catchUpRate k (default 1), catchUpSize s (default 1) }
state  = { contributedCapital C, returnedCapital R, preferredPaid P, preferredTarget T,
           gpCarryPaid G, gpCatchUpPaid Q (default G) }
distributable D
```

The function is pure: it takes a distributable amount and the cumulative state. The caller works
out the accrued hurdle `T` (§5). Timing stays out of the waterfall. `Q` is the GP's catch-up so
far, kept apart from `G` because carry from the split does not count toward the catch-up. Absent,
it is `G`, which is exact for any state that has not reached the split.

### 3.2 Tiers, in order

A catch-up is two terms:
- Its **size** `s` is how much of a full catch-up the GP gets. A full catch-up is the carry the GP
  would have earned on the profit that paid the preferred return: enough that the GP holds `c` of
  the pref plus the catch-up, which is `c·P'/(1 − c)`. A size of 0.5 is half of that.
- Its **rate** `k` is the share of each dollar that goes to the GP while it catches up. The LPs get
  `1 − k`. The catch-up stops when the GP's catch-up reaches its size, whatever the rate.

Example: 20% carry and 80 of pref paid. A full catch-up is 20 (the GP then holds 20 of 100). At a
100% rate the GP takes the next 20; at 10% it takes 10% of the next 200, and the LPs get 180.

Let `rem = round(max(0, D))`. Each tier is `take(want) = round(max(0, min(rem, want)))`, and then
`rem = round(rem − take)`.

1. **Return of capital:** `ROC = take(C − R)`.
2. **Preferred return:** `PREF = take(T − P)`. Let `P' = round(P + PREF)`.
3. **GP catch-up.** This tier applies only when `0 < c < 1`, `k > 0` and `s > 0`.
   - The GP is owed `N = round(max(0, s·c·P'/(1 − c) − Q))`. Nothing owed, no catch-up.
   - Flow: `want = round(N / k)`, `gross = take(want)`.
   - `CU = gross = want ? N : round(gross × k)` goes to the GP, and `CUlp = round(gross − CU)` to
     the LPs. Rounding the GP part, not the flow, lands a completed catch-up to the cent.
   - **Measured on profit** (`catchupMeasure: profit`), the catch-up runs until the GP holds `t` of
     all the profit distributed, where `t ÷ (1 − t) = s·c ÷ (1 − c)` (`t = c` for a full one). With
     `Π` the profit so far (the LPs' after return of capital, `P'` included, plus the GP's `G`):
     `want = round(max(0, (t·Π − G) ÷ (k − t)))`, and a completed catch-up gives the GP
     `round(t·(Π + want) − G)`. It needs `k > t`. The state carries the LPs' profit so far
     (`lpProfitPaid`) for it.
4. **Carry split:** `GPsplit = round(rem × c)`, and `LPsplit = round(rem − GPsplit)`.

Outputs:
- `toLP = round(ROC + PREF + CUlp + LPsplit)`, with `toCatchUpLP = CUlp`.
- `toGP = round(CU + GPsplit)`.
- `state' = { C, R + ROC, P', T, G + toGP, Q + CU }`.

The tiers always add up to the rounded distributable. The vector test checks that for every vector.

**Rate below 1.** The GP takes `k` of the flow and the LPs `1 − k`, literally:
- When the catch-up completes, the GP has its catch-up and the split takes over (vectors
  `partial-catch-up-80`, `catch-up-rate-below-carry`).
- When the distribution runs out inside the catch-up, the GP has `k` of what there was (vector
  `partial-catch-up-runs-out`: 12 of 15).
- Because the LPs share the catch-up flow, the GP ends below `c` of all profit until a fund-close
  true-up says otherwise.

**Size below 1.** The catch-up stops early, at `s` of a full one (vector `catch-up-half-size`).

**After the split.** When the hurdle grows after the fund has reached the split (a later
distribution, more pref accrued), the new pref is caught up in turn: the GP is owed `s` of a full
catch-up on the larger `P'`, less the catch-up it already has (vector `catch-up-after-split`).

### 3.3 Carry that steps up (`steps`)

Some LPAs raise the carry once the LPs are well ahead: 20% until the LPs have received 2.5x their
capital, then 25%. Each step in `carrySteps` ends the split before it and starts a new one at its
own `carryRate`. With `L` everything the LPs have received (return of capital included) and `Π`, `G`
as in §3.2, the split at rate `g` before a step takes:

- at an **LP multiple** `m`: `want = (m·C − L) ÷ (1 − g)`, which leaves the LPs at exactly `m·C`;
- at an **LP IRR** `r`: `want = S ÷ (1 − g)`, where `S` is what the LPs still need, in today's
  dollars, for their IRR to reach `r` on the distribution date: their contributions compounded at
  `r` (ACT/365) to today, less what they have received compounded the same way. The state carries
  the LPs' dated cash (`irr`) for it, and the replay fills it in.

An optional catch-up at a step (`catchUpRate` `k`) runs first, measured on all profit:
`want = (t·Π − G) ÷ (k − t)` with `t` the new rate, so the GP holds the new rate of everything when
it finishes. The last split runs on whatever is left. `toCarryGP` and `toCarryLP` are the totals of
every split and step catch-up, and `bands` lists each one.

The close's accrual runs the steps on its hypothetical liquidation. An IRR step there treats every
dollar as coming back on the accrual date, which can only understate the LPs' IRR, so the accrual
never reaches a step early. Vectors `split-tiered-multiple` and `split-tiered-irr-catch-up`.

## 4. Kinds

### 4.1 `none`
No carry accrues. A distribution is split **pro-rata by capital balance** across every partner,
recipients included (`method: 'pro_rata'`). The same fallback applies when carry is on but no
recipient is set, and the split warns that it has done so.

### 4.2 `straight`
Carry is a share of profit over contributed capital, with no hurdle and no catch-up.
- **Accrual target:** `c × max(0, NAV + distributed − contributed)`, summed over non-recipient
  partners.
- **Distribution:** runs the waterfall with `T = 0` and `k = 1`. Return of capital first, then the
  split. With `T = 0`, the catch-up target is 0 and the tier disappears.
- A stored `prefRate` or `catchupRate` is ignored.

### 4.3 `european` and `american`
- **Accrual target (the close):** the hypothetical-liquidation method. The waterfall runs once
  from a clean state, `{C = contributed, R = 0, P = 0, T = hurdle(asOf), G = 0}`, on
  `D = NAV + distributed`. The target is `toCatchUp + toCarryGP`. On the `unreturned` base the
  hurdle is the one the actual distributions leave (§5), found by replaying them whole-fund.
- **`american` accrues exactly the `european` target.** A liquidation realizes every deal, so the
  deal-by-deal capital base is the whole fund, and a clawback makes the GP's ultimate entitlement
  the whole-fund result. The accrual marks that ultimate entitlement.
- **`european` distributions** run the replay and split of §6 on all contributed capital.
- **`american` distributions** run the same replay and split, but the capital tier is the LP
  capital in deals **realized** by each distribution's date, and the hurdle accrues only on that
  capital, from when it was invested (vector `american-realized-deals`):
  - A realization is a sale, a partial sale or a write-off, with the cost basis it took out
    (`cost_basis_exited` on a proceeds row; none stated means all the basis left). A deal closed
    by status alone realizes what is left on the date of its last transaction.
  - Each realized dollar of cost is LP capital times
    `factor = (LP contributions ÷ all contributions) × (1 + fund fees and expenses ÷ total cost)`,
    so fees and expenses ride with the deals by cost share and the GP's own capital is left out.
    The slice is spread over the deal's investments in proportion, each dated when it was made.
  - Written-off deals count: their capital is owed back before carry on the next winner.
  - The base never exceeds the LPs' contributions to that date.
  - With no deal data supplied the split falls back to whole-fund and warns (vector
    `american-without-deals-is-whole-fund`). With deal data but nothing realized yet, every dollar
    is profit, and the split warns that a return of uninvested capital belongs pro-rata.
- `dealByDealCarry` (§6) still reports each deal's own carry, for the GP panel.

## 5. The hurdle (`preferredTarget`)

**`contributed` base** (the default):

```
T(asOf) = Σ over contributions with amount > 0 and date < asOf of
            compounds ? amount × ((1 + rate)^years − 1)
                      : amount × rate × years
years = (asOf − date) / 365 days      (ACTUAL/365)
```

- The hurdle accrues on each contribution from the day the cash arrived. Commitments earn nothing.
- Capital coming back does not stop it (vector `no-reduction-for-returns`).

**`unreturned` base.** Walk the dated events in order: contributions add to unreturned capital
`K`; each prior distribution's return-of-capital tier takes from `K` and its preferred tier from the
unpaid pref `U` (on one date, contributions land first). Between events, over `years`:

```
growth = compounds ? (K + U) × ((1 + rate)^years − 1)
                   : K × rate × years
T += growth;  U += growth
```

`T` is still cumulative, everything accrued whether paid or not, because the waterfall compares it
with cumulative `P`. What each distribution returned and paid comes from replaying the waterfall
itself (§6), so the hurdle a distribution sees is the one the earlier tiers leave. Vectors
`unreturned-compound-pref-paid`, `unreturned-capital-back`, `unreturned-simple`,
`unreturned-replay-then-split`, `european-unreturned`.

**Day count.** Years are ACTUAL/365 unless `prefDayCount` is `30/360`, the US bond basis: every
month has 30 days, a 31st counts as the 30th, and an end date on the 31st counts as the 30th only
when the start was a 30th or 31st.

**A multiple hurdle.** With `prefMultiple` set, `T = (prefMultiple − 1) × C`, flat: the LPs get
`prefMultiple` × their capital back through the first two tiers, whenever it arrives. The rate,
compounding, base and day count don't apply. (`hurdleTarget` picks between the two.)

Both bases:
- A contribution dated on or after `asOf` accrues nothing.
- A year under ACTUAL/365 is 365 days, so a 366-day leap year accrues slightly more than one year
  (vector `leap-year`).
- The result is rounded to cents. `rate ≤ 0`, or an unparseable `asOf`, gives 0.

### 5.1 What counts as capital (`capitalIncludes`)

Most LPAs return every contribution before carry: what paid for investments, and what paid the
management fee and partnership expenses. Some return only invested capital. `capitalIncludes`
lists the purposes that count, and the first tier returns, and the hurdle accrues on, only those
(`capitalContributions` in hurdle.ts).

The books don't record which call paid which fee, so `datedContributions` (economics.ts) tags each
LP's contributions first in, first out: a management fee or partnership expense charged to the
LP's account uses the LP's oldest capital not yet used, and a charge with no capital left to use is
paid by the next contribution. What no charge uses is invested capital. With every purpose included
the tags change nothing. Vector `roc-excludes-fees`.

A forecast can't tag a projected call, so the forecasts count future calls in full.

## 6. Splitting a distribution (`splitDistribution`)

1. **Replay.** Nothing stores the waterfall state, so it is replayed:
   - Every prior distribution with `amount > 0` and `date ≤ asOf` runs through `runWaterfall` in
     date order.
   - For each prior, `C` is the contributions dated on or before the prior's date (for `american`,
     the realized capital, §4.3), and `T` is the hurdle accrued to that date (§5).
   - The final state is then re-based to `asOf`: `C` and `T` are recomputed as of `asOf`.
2. **Split.** This distribution runs from the replayed state.
3. **The GP's own capital.** A carry recipient that has contributed (the GP's commitment) bears no
   carry, so before the tiers it takes its pro-rata share of the distribution by contributed
   capital: its own capital back first, then its profit (`carryFreeLines`). The tiers divide what
   is left, and the replay's priors leave the recipients' own distributions out, so it only ever
   sees what the tiers divided. With `gpCommitBearsCarry` there is no carry-free share: the
   recipients are partners in the LP tiers (`PartnerEconomics.carryBearing`), their contributions
   are in the hurdle, and their own distributions are in the priors.
4. **LP lines.** `toLP` is split pro-rata by each non-recipient partner's contributed capital. When
   no partner has contributed, it falls back to capital balance. The carry-free shares are added
   to the same `lines`.
5. **Carry lines.** `toGP` is split across the recipients by `pct`. The last recipient absorbs the
   rounding cent.
6. **Warnings.** The split warns when the replay's implied carry paid differs from the books by
   more than 0.01.
7. **Tax character.** The suggested character is: the return-of-capital tier and the carry-free
   capital = return of capital, and the rest = gain.

A carry rate of 0 still runs the tiers when the kind isn't `none`, so the split says what came back
as capital.

**Clawback at fund end (`clawbackAtFundEnd`).** Return of capital owes only what has been called,
so an early exit can pay carry the fund's life doesn't support. The fund-end view replays every
distribution with return of capital owing all the capital contributed to the end date from the
first one, whole fund, with the hurdle still accruing on each contribution from its own date. The
GP's carry on that view is its entitlement, and the clawback is `max(0, carry paid − entitlement)`.

**Close accrual.**
- The close measures each LP **gross of carry**: `NAV = ending capital + carry already charged to
  that LP` (what earlier accruals debited from its `carriedInterest` line). Measuring on a balance
  already net of carry would count it twice, and a second close on unchanged books would propose
  reversing part of what the first accrued.
- It posts `carryTarget − alreadyAccrued`, where `alreadyAccrued` is the carry charged to the LPs
  so far. That is not the recipients' balance: carry PAID is drawn from the recipients, so
  measuring against their balance would accrue every paid dollar again.
- It is a **true-up to the capital accounts**. The whole target is shared across LPs in proportion
  to each LP's positive profit (`NAV + distributed − contributed`), with largest-remainder cents,
  and each LP is charged its share less what it has already been charged. Its cumulative charge is
  then always its share of the GP's entitlement, so at the fund's last close every LP pays the same
  effective rate on its profit, however earlier accruals were shared. A close whose total does not
  change can still move carry between LPs.
- The net is credited across the recipients by `pct`. The last recipient absorbs the rounding.
- When NAV falls, the accrual reverses on its own; when nobody is in profit, every LP's charge is
  reversed.
- Carry paid beyond the target is not clawed back by the close: it shows as a negative carry
  balance on the recipients' capital accounts, which is what the GP owes back.

**Deal-by-deal entitlement (`dealByDealCarry`).**
- Fund expenses are allocated to deals by share of cost basis.
- `profit = proceeds + remainingValue − (costBasis + allocatedExpense)`.
- `carry = c × profit` when profit is positive, else 0. Losers do not offset winners.

## 7. Not supported yet

An LPA with any of these provisions needs a person's attention. `extract_lpa_terms` reports each
one it finds under `unsupported`.

| Provision | What the engine does instead |
|---|---|
| GP clawback / give-back | Computed (`clawbackAtFundEnd`, §6) but not posted. The close's accrual marks the whole-fund entitlement, so carry paid early under `american` beyond it shows as accrued vs paid on the GP panel. |
| Carry escrow / holdback | Not modelled. |
| Multiple hurdles (a second pref) | One hurdle per vehicle. Carry that steps up at an LP multiple or IRR is supported (§3.3). |
| Hurdle compounding other than annual (quarterly, daily) | Annual compounding or simple only. |
| Deal-by-deal on a different capital base (all invested capital, or unrealized write-downs) | Realized deals only, with fees and expenses by cost share (§4.3). |
| Per-partner carry rates (side letters on carry) | Carry is fund-level. Side-letter *fee* rates are supported (`rate_override`). |
| Tax distributions | Not modelled. |
| Fee step-downs as a waterfall term | Belongs to the forecast plan's fee rule, not these terms. |

## 7a. The open spec

[Walter](https://github.com/tdavidson/walter) is an open spec for the same terms with its own
conformance vectors. `lib/accounting/walter/` runs this engine on them in `npm test`, and it passes
all of them.

## 8. Reading terms from an LPA

`extract_lpa_terms` (read, GP economics) reads an LPA into a **proposal** in the shape of §2.
- **Inputs.** The source is either one of the vehicle's entity documents (its extracted text,
  OCR included) or pasted text.
- **Per field.** Each field comes with its quoted clause, section, page and a confidence of
  `high`, `medium` or `low`. It also says whether the quote was found in the document. A quote
  that is not found caps the field at `low`.
- **Not found.** Fields no reader found are listed under `notFound`. They are never defaulted
  silently.
- **Other output.** Recipients are kept from today's terms, or suggested when the fund has exactly
  one GP-class partner. The management fee is reported as information.
- **Readers.** The fund's model reads it when the fund has a server AI key. Otherwise the pattern
  reader runs, and the person's own assistant reads the passages and hands its reading back as
  `assistantProposal`. That reading goes through the same checks (`lib/accounting/lpa-terms.ts`).

Applying a proposal is `set_waterfall_terms`, which is always staged as a pending action:
- The approver sees today's terms beside the new ones, with each clause re-checked against the
  document.
- Approval needs GP economics write.
- Approval runs the same validation and write as the settings page.

## 8a. Recycling

Recycling is exit proceeds a vehicle puts back to work instead of distributing. Its terms sit on
the same row as the carry terms (`recycle_*` columns) because they come from the same LPA clauses,
but they are read and written on their own (`lib/accounting/recycling.ts`), so setting one never
resets the other.

| Term | Column | Meaning |
|---|---|---|
| Cap | `recycle_cap_rate` | A fraction of the basis. 0 means the vehicle does not recycle. |
| Basis | `recycle_cap_basis` | `commitments` (the default) or `management_fees` paid to date. |
| End | `recycle_until` | Proceeds received after this date are not recycled. Null means no end date. |
| Uses | `recycle_uses` | `any`, `new_investments` or `follow_ons`. Recorded for the approver; not enforced. |
| Default treatment | `recycle_default_treatment` | `retained` (the default) or `deemed`. |

Each recycled amount is a row in `recycled_proceeds`, booked one of two ways:
- **Retained (never distributed).** Nothing is posted. The cash is already in the bank, keeping it
  is what makes the next call smaller, and the row counts against the cap.
- **Deemed (distributed and recontributed).** One posted entry, `recycled_proceeds`, with no cash
  and no notices. Each partner's share, split by commitment like a call, is debited to their
  capital and credited to 2300, then debited to 2300 and credited back to their capital. It is
  the one source type whose roll-forward line depends on the posting's sign (debit =
  distribution, credit = contribution), so the partner's statement and K-1 show both. The
  distribution is recallable, so uncalled commitment is `commitment − called + recontributed`.

The two legs are dated the same day, so the waterfall reads the distribution as a return of the
capital recontributed with it. On an `unreturned` hurdle that nets to nothing. On a `contributed`
hurdle the recontribution is contributed capital and accrues the preferred return from its date,
which is the economic difference between the two treatments.

The cap is checked when an amount is recorded: what is left is the cap less the live rows (a
deemed row whose entry was voided no longer counts), and nothing may be recycled after the end
date. The tools are `recycling` (read), and `set_recycling_terms`, `record_recycling` and
`remove_recycling`, each always staged for a person with LP capital write to approve. To undo a
deemed amount, void its entry with a reason, then remove the row.

The forecasts recycle with their own assumptions (portfolio construction's return assumptions and
each deal's own amount and treatment), using the same allocation as the fund engine's
`allocateRecycling`: amounts that are set go first, then the earliest exits fill what is left.

## 9. Vector index

Every vector in `waterfall-vectors.json`, by section:

- **runWaterfall:** `roc-only`, `roc-and-partial-pref`, `european-full-catch-up`,
  `catch-up-rate-omitted`, `partial-catch-up-80`, `partial-catch-up-runs-out`, `no-catch-up`,
  `resume-mid-catch-up`, `zero-carry`, `straight-shape`, `rounding-to-cents`,
  `sub-cent-distributable`, `negative-distributable`, `carry-25-large`, `catch-up-after-split`,
  `catch-up-rate-below-carry`, `catch-up-half-size`.
- **preferredTarget:** `one-year-compound`, `one-year-simple`, `two-years-compound`,
  `two-years-simple`, `leap-year`, `per-contribution-dates`, `no-reduction-for-returns`,
  `zero-rate`, `unreturned-compound-pref-paid`, `unreturned-capital-back`, `unreturned-simple`.
- **carryTarget:** `none`, `straight`, `straight-loss`, `european`, `european-below-hurdle`,
  `american-equals-european`, `european-unreturned`, `european-contributed-same-books`.
- **splitDistribution:** `replay-then-split`, `american-without-deals-is-whole-fund`,
  `straight-split`, `two-recipients`, `no-terms-pro-rata`, `unreturned-replay-then-split`,
  `american-realized-deals`.
- **dealByDealCarry:** `two-deals`.

Changing the engine means changing this document and its vectors in the same change.
