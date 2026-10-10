---
name: fund-dashboards
description: >
  This skill should be used when the user asks to see, show, open, chart, visualize or save a
  view of their fund through the Portfolio connector: "show me the portfolio", "open the
  dashboard for Acme", "chart Acme's ARR", "pull up the balance sheet", "show the P&L for last
  quarter", "who has funded", "show LP capital", "what dashboards do I have", "open my Q3 LP
  dashboard", "save this dashboard as ...", "pin this", "delete that dashboard".
metadata:
  version: "1.0.0"
---

# Fund dashboards

The Portfolio connector can draw four dashboards in the conversation. Each is a tool that
returns the figures as text (for answering questions) and renders them as an interactive view
(for the user to look at). Use them whenever the user wants to *see* something. For a question
that only needs a number, the `fund-analysis` skill applies instead.

## Pick the dashboard

| The user wants | Tool | Arguments |
| --- | --- | --- |
| The portfolio, holdings, the fund at a glance | `show_portfolio_dashboard` | `vehicle?`, `as_of?` |
| One company: its position, KPIs, rounds | `show_company_dashboard` | `company`, `vehicle?` |
| Balance sheet, income statement, cash flows, partners' capital | `show_financial_statements` | `vehicle?`, `period?`, `start?`, `end?` |
| LPs, commitments, who has funded, capital accounts | `show_lp_dashboard` | `vehicle?`, `as_of?` |
| A dashboard the user names ("my Q3 LP review") | `open_dashboard` | `dashboard` |

Rules for the arguments:

- Pass a company by the name the user said. If the tool answers that the name matches several
  companies, or suggests near matches, ask the user which one. Do not guess.
- `vehicle` is a fund or SPV. Leave it out to cover every vehicle the user can see. Financial
  statements are per vehicle: if the tool answers "Specify a vehicle" it lists them, so ask the
  user which, or call `list_vehicles`.
- `period` for statements is one of `this_quarter`, `last_quarter`, `ytd`, `prior_year`, `itd`.
  The default is `ytd`. For anything else pass `start` and `end` as `YYYY-MM-DD`.
- Leave `as_of` out unless the user names a date. Without it the figures are current.

## After the dashboard appears

The user is looking at the figures. Do not repeat them back.

- Say what stands out in one or two sentences: the largest position, a company marked below
  cost, an LP who has not funded, a balance sheet that does not balance.
- Answer follow-up questions from the text the tool returned. It holds everything the view
  shows, and it is what the fund's books and tracker say, so quote it exactly.
- The user can drill in, change the period or sort inside the view without asking. When they
  do, a note arrives saying what they are now viewing. Treat that as the current subject: "what
  is its MOIC?" refers to the company on screen.
- If the assistant shows only text and no view, present the same figures as a short table.

## Open a saved dashboard

When the user asks for a dashboard by a name:

1. Call `open_dashboard` with that name.
2. If it answers that there is no such dashboard, it lists the ones available. Offer the
   closest, or call `list_dashboards` and show the list.

`list_dashboards` returns three kinds: `standard` (always there), `mine` (the user saved it)
and `shared` (a colleague shared it with the fund). When the user asks "what dashboards do I
have", list their own first, then the shared ones, then the standard ones.

## Save a dashboard

Save only when the user asks to save, keep or pin one. Never save on your own initiative.

1. Use the name the user gave. If they gave none, ask for one.
2. Call `save_dashboard` with `name`, the `view`, and the `arguments` of the dashboard on
   screen. Each dashboard result carries its own `view` and `arguments`: copy them.
3. Leave `as_of`, `start` and `end` out of the saved arguments unless the user wants the date
   pinned. A dashboard saved without dates opens on current figures every time, which is
   almost always what "save this" means. A `period` such as `last_quarter` is fine: it moves
   with the calendar.
4. Set `shared` to true only if the user asks to share it with their team.
5. Confirm in one sentence, with the name to ask for next time.

Saving under a name the user already has replaces that dashboard. Say so if that is what
happened.

If saving is refused because the connection is read-only, say that plainly: the user connected
with read-only access, and saving needs a connection that is allowed to make changes. They can
reconnect the connector and approve write access, if their role in the fund allows it. Until
then they can still open any dashboard by asking for it.

## Refusals

A dashboard tool may answer that the user's access does not include an area (fund accounting,
LP capital). That is the fund's own access control, set by its admin.

- Tell the user which area they lack and that their fund's admin grants it.
- Do not retry, and do not try to assemble the same figures from other tools.

If every tool answers that agent access is disabled for the fund, an admin has switched the
connector off in Settings. Say so and stop.
