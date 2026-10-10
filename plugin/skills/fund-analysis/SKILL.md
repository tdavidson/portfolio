---
name: fund-analysis
description: >
  This skill should be used when the user asks a question about their fund that the Portfolio
  connector can answer from the fund's own records: "what is our TVPI", "how much have we
  called", "what did we invest in Acme", "which companies are marked below cost", "what is
  Acme's runway", "how much has each LP funded", "what is our net income this year", "do our
  books agree with the administrator", "what did Acme say in their last update" — and when the
  user wants an LP document as a file: "send me Cranmore's capital account statement", "a PDF of
  the report card for Aldis".
metadata:
  version: "1.1.0"
---

# Answering questions about the fund

The Portfolio connector reads the fund's own tracker and books. Answer from it, not from
memory or estimates, and say what the figure is "as of".

If the user wants to *look at* something rather than get an answer, show a dashboard instead
(the `fund-dashboards` skill).

## Which tool answers what

| Question | Tool |
| --- | --- |
| Which funds and SPVs exist | `list_vehicles` |
| Which companies we hold, by stage, industry or status | `list_companies` |
| One company: what it does, why we invested, cost, value, MOIC | `company_detail` |
| Every position with cost, fair value, MOIC and share of the portfolio | `portfolio_summary` |
| Committed, called, distributed, NAV, DPI, TVPI per vehicle | `fund_performance` |
| A company's KPIs over time | `company_metrics` |
| What a company reported in its updates | `get_updates` |
| The raw investment transactions | `list_investments` |
| LP positions as the books say today | `lp_live_report` |
| LP positions as the administrator reported them | `lp_snapshot` |
| Whether the books agree with the administrator | `lp_reconcile_snapshot` |
| One LP's capital account statement | `lp_statement` |
| One LP's capital account statement **as a PDF** | `lp_statement_pdf` |
| An investor's report card (every vehicle aggregated) **as a PDF** | `lp_report_card_pdf` |
| Capital calls and who has funded them (including "says wired" from the LP portal) | `lp_capital_calls` |
| Balance sheet, income statement, trial balance | `financial_statements` |
| Budget and forecast against actuals | `forecast_variance`, `forecast_series` |

The two PDF tools return a link, not the document. Give the user the link as a link, say it
works for an hour and only for them, and do not try to open or summarize it — call
`lp_statement` or `lp_live_report` for the figures. A statement is per LP entity and per vehicle;
if the name matches several entities, ask which.

Only the tools the user's access allows are listed for them. If a tool here is not available,
the user's access does not include that area: say so, and do not look for another route to the
same figures.

## The fund's definitions

Use these exactly. They are how the app itself computes the figures.

- **Paid-in capital is called capital.** Capital counts when it is called, whether or not the
  LP has funded it yet. Paid-in is the denominator of DPI, RVPI and TVPI.
- **Sum first, then take the ratio.** A fund's TVPI is total value over total paid-in, never an
  average of each LP's or each vehicle's TVPI. The same holds for DPI, RVPI and MOIC.
- **DPI** is distributions over paid-in. **RVPI** is NAV over paid-in. **TVPI** is their sum.
- **MOIC** on a position is fair value plus realized proceeds, over cost.
- **IRR** values come back as fractions: 0.214 is 21.4%.
- **An investor may hold through several entities.** LP positions are per entity and per
  vehicle. To report on an investor, sum their entities, then compute ratios.
- **A snapshot and the live report can differ.** A snapshot is what the administrator reported
  as of a date. The live report is what the books say now. Never mix them in one answer, and
  say which one a figure came from. If they differ, that difference is the finding:
  `lp_reconcile_snapshot` shows it line by line.
- **A balance sheet is as of a date; an income statement covers a period.** State the date or
  the period with every statement figure.

## How to answer

- Lead with the figure and its "as of", then one sentence of context if it helps.
- Quote figures as the tool returned them. Round only for readability, and never round a ratio
  to hide a difference the user is asking about.
- When a question spans several vehicles, say whether the answer covers all of them or one.
- When a name matches more than one company or investor, ask which. Do not pick.
- When a tool returns nothing for a period, say there is nothing recorded. Do not infer a zero.

## Changes to the fund's records

Some tools change the fund's records: recording an investment, posting a journal entry,
closing a period, saving a forecast. They are available only on a connection the user approved
for changes, and only to users whose role allows them.

- Never call one unless the user asked for that specific change in this conversation.
- Before calling it, state exactly what will be recorded (the vehicle, the date, the amounts)
  and get a yes.
- After it, report what the tool returned, including any entry it created.
- Closing a period is not reversible from here. Say that before asking for the yes.
