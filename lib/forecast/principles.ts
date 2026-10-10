// How this app forecasts a fund, an SPV, a GP entity and a management company — stated once, and
// handed to every tool that drafts or explains a forecast, so the Analyst reasons the way the
// engine computes. Each line is something the engine does (cited), not advice.

export const FORECASTING_PRINCIPLES = [
  // Construction is the source of a fund's investment economics (lib/forecast/plan.ts).
  'Portfolio construction is the source for a fund or SPV: with includeConstruction on, its investments, exits, capital calls and distributions come from construction, and so do its management fees and partnership expenses on any account without its own rule. Set includeConstruction for any fund, SPV or GP entity with construction pacing; do not re-enter those flows as manual rules.',
  // GP entity (lib/forecast/linked.ts gpShareOf).
  "A GP entity's forecast comes from the fund it is GP of, not from its own construction: with includeConstruction on, it takes its share of the fund's calls and distributions (its commitment over the fund's) and its percent of the carry the fund's waterfall pays, in the months of the fund's forecast exits. Do not add carry or distribution rules to a GP entity by hand.",
  // GP stake exemption (lib/accounting/construction.ts feePayingShare, construction-forecast.ts applyLpWaterfall).
  "The GP's own commitment pays no management fee and bears no carry. Fees are charged on the fee-paying commitments only; carry is the carry rate times the LPs' gain (their share of distributions beyond their capital), never on the GP's stake.",
  // Carry paid to date (lib/accounting/construction-service.ts carryInferred).
  'Carry already paid comes from the books (carry distributions). Where the books record none and there is no preferred return, it is worked out from the LPs\' distributions beyond their capital — rate ÷ (1 − rate) of that excess — so only carry still to come is forecast. portfolio_construction reports it as waterfall.carryPaidInferred; say so when you quote a carry total.',
  // Management company (linked_fee).
  "A management company's fee revenue is a linked_fee rule: each linked fund's construction fee schedule, on that fee link's billing cycle. It changes when the fund's construction changes.",
  // Prepaid (lib/forecast/compile.ts).
  'A cost paid before the plan and expensed monthly (a prepaid fee) uses cashTiming {mode:"prepaid"} — it draws down the prepaid balance with no cash in the plan. Never push cash outside the window with a large offset; offsets are limited to ±36 months.',
  // Hand edits (lib/forecast/adjustments.ts).
  'To change what construction or an opening balance generated, or to add a one-off: use update_forecast_plan. Prefer cashFigures (what Investments, Exit proceeds, Capital contributions or Distributions should be in a month — the entry is written for you); a P&L month is an override; write entries (balanced, with replaces for a generated one) only for what neither covers. Hand edits are kept through refreshes.',
  // Staleness and versions.
  'A draft recompiles from its sources when refreshed; a change to construction, a linked fund or the actuals marks it out of date. Published versions never change.',
].join(' ')
