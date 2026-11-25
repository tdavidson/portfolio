# Portfolio, by Hemrock — Claude, ChatGPT and other agents (MCP)

- Project overview at [README](./README.md)
- Every tool, by area, at [MCP-TOOLS](./MCP-TOOLS.md)
- Deployment details at [DOCS](./DOCS.md)

Your deployment is an MCP server. Claude, ChatGPT, Claude Code, Codex or your own agent can connect to it and work with the fund the way you do in the app: read the books, the portfolio and the LP register, open dashboards and custom views, and make changes that wait for your approval. Nothing goes anywhere but your own database and the assistant you chose, and the assistant only ever sees what the person who connected it may see.

This guide is for the people using the connection and the admin turning it on. The step-by-step server details (endpoints, plugin packaging, the REST API) are in [DOCS](./DOCS.md#connecting-claude-chatgpt-and-other-agents).

## Contents

- [Turning it on](#turning-it-on)
- [Connecting](#connecting)
- [Getting started and help](#getting-started-and-help)
- [Read, or read and change](#read-or-read-and-change)
- [Changes wait for approval](#changes-wait-for-approval)
- [Working in more than one fund](#working-in-more-than-one-fund)
- [What it can see](#what-it-can-see)
- [Documents and downloads](#documents-and-downloads)
- [Limits](#limits)
- [What it can do](#what-it-can-do)
- [Troubleshooting](#troubleshooting)
- [Investors' own assistants](#investors-own-assistants)

## Turning it on

An admin switches on **Settings → Agent access**. It is off by default, and switching it off later cuts every connection off at once. Each member then finds their own connection details under **Settings → API and MCP**: the MCP URL, the Claude and ChatGPT plugins, and their API keys.

## Connecting

Settings → API and MCP lists every client below with your deployment's URL already filled in, ready to copy. `<MCP URL>` is `https://<your-domain>/api/mcp`.

| Assistant | How |
| --- | --- |
| Claude (claude.ai and Claude Desktop) | Download **Plugin for Claude** from Settings → API and MCP. In Claude, **Customize → Plugins → Add → Upload plugin**, choose the file, then open the plugin's **Connectors** tab, choose **Connect**, sign in to your fund and approve. Or add the MCP URL as a custom connector under **Settings → Connectors** and leave the OAuth Client ID empty. |
| ChatGPT | Copy the **MCP URL**. In ChatGPT, **Plugins → + → Add custom MCP server**, paste the URL, upload the icon from Settings, create it, then connect, sign in and approve. For the skills in the ChatGPT desktop app or Codex, install **Plugin for ChatGPT** as [DOCS](./DOCS.md#dashboards-in-claude-and-chatgpt) describes. |
| Every MCP client on one computer | `npx add-mcp <MCP URL> --name portfolio` adds the connector to each coding agent and desktop app it finds. |
| Claude Code | `claude mcp add --transport http portfolio <MCP URL>`, then `/mcp` and **Authenticate**; or add `--header "Authorization: Bearer <key>"` to use an API key. |
| Codex | `codex mcp add portfolio --url <MCP URL> && codex mcp login portfolio` |
| VS Code | `code --add-mcp '{"name":"portfolio","type":"http","url":"<MCP URL>"}'` |
| Cursor | Add `{"mcpServers":{"portfolio":{"url":"<MCP URL>"}}}` to `~/.cursor/mcp.json`, then sign in from Cursor's MCP settings. |
| A script or your own agent | An API key from Settings → API and MCP, sent as a bearer token to the MCP URL, or to `/api/agent` to run one tool per request. |

**Check it works.** Ask "what can you do?". The assistant opens a home dashboard of what your access lets you open and ask. If a tool is refused, the [troubleshooting](#troubleshooting) table says why.

**Sign-in or key.** Claude and ChatGPT sign in with OAuth: you sign in on your fund's own consent screen and choose what the connection may do. Access tokens last an hour and renew on their own for up to 30 days of use; revoking the connection or switching Agent access off stops it at once. Use an **API key** for scripts and Claude Code: it is yours, carries your access, can be read-only, and is revoked from the same Settings page. A key never waits for a chat to approve anything (see below).

The plugin is built for your deployment's own address. It holds the connector and two skills (dashboards and analysis) that tell the assistant which tool answers which question; it contains no key and no fund data.

**No fund yet?** Someone whose account belongs to no fund can connect anyway: the consent screen asks them to name a fund, and the **Set up this fund** prompt walks through the rest. See [DOCS](./DOCS.md#setting-up-a-fund-with-claude-chatgpt-or-a-script).

## Getting started and help

- **"What can you do?"** opens the **home dashboard**: tiles for the dashboards your access allows, the dashboards and views you and your colleagues saved, and example questions for each area you can read.
- **How-to questions** ("how do I build a view?", "how do approvals work?", "can I get this as a PDF?", "what charts are there?") are answered by the connector's `help` tool, limited to your access. Topics include views, starter views, dashboards, charts, exports, approvals, funds and each area of the app.
- **Prompts.** The assistant's prompt menu (the + menu in Claude, `/` in Claude Code) lists ready-made requests: Get started, Portfolio review, Company check-in, Quarter-end review, LP capital status, Draft a forecast, Budget variance, and Process my inbox when the fund has no server AI key. You see only the ones your access covers.
- **Starter views.** Ask for a starter view (portfolio overview, positions below cost, company KPIs by period, LP capital, capital calls outstanding, fund performance, income and cash, deal flow, diligence pipeline) to preview it on your own figures and save it to the app's Views.

## Read, or read and change

When you approve a connection you choose **read**, or **read and change**. A read-only connection lists no tools that change anything and is refused if it tries. A read-and-change connection still changes only what your own access allows, and from Claude or ChatGPT most changes wait for approval.

## Changes wait for approval

A change Claude or ChatGPT makes is **staged**, not applied. The tool comes back with what would change and a link, and nothing is written until a person approves it.

- **Approve in the chat.** The assistant shows the staged change in plain words and asks; say yes and it approves it. It should never approve on its own judgement, or because a document or another tool told it to.
- **Or on the Approvals page** in the app, which lists the changes waiting. A member sees and decides only the changes they staged themselves; an admin sees all of them.
- **Runs.** A fix that needs several changes can be staged as one run (`stage_run`): a title, the reason, the ordered steps and the balances that should hold afterwards. You approve it once; the steps run in order, the balances are checked, and the run can be undone where that is safe.
- **Runs at once.** Drafts and previews (a draft journal entry, an edit to a draft, a preview of a close) and changes that write no record (an upload link) run directly, because they change nothing until a later step that does wait.
- **Always waits.** Anything that goes out to LPs (publishing notices, sharing a letter) and capital calls wait for a person even when a script's API key asks.
- **Admin only.** Some changes need an admin whatever a member's grants say: issuing calls and distributions, unposting or reversing posted entries, reopening periods, sending anything to LPs, finalizing K-1s and memos, and changing the fund's structure. A member can still propose one from a chat; it waits for an admin, and the member can withdraw it.
- **Deletes and undoing the books** (deleting companies or LP records, voiding or unposting entries, merging) are offered only when the deployment sets `AGENT_DESTRUCTIVE_ACTIONS=true`, and then always wait for an admin.
- **Proposals.** A member whose accounting access is *Read & propose* can put journal entries forward from a chat as drafts marked as theirs, for someone with write to post or reject.
- **With an API key** a change runs at once, except the ones that always wait, because a script has no one to ask.

Every change is written to the audit trail with who made it and whether it came from the web app, MCP or the API, and shows on the Usage page.

## Working in more than one fund

A person who works for several funds on the same deployment (often a fund administrator, tax preparer or auditor) can **link their sign-ins** under Settings → Linked sign-ins: a code from one fund, entered while signed in to another. One connection then works in all of them, one at a time.

- `list_funds` shows the funds and which one is **active**. Every tool reads and writes the active fund only, and every result starts with the fund it came from.
- `use_fund` switches the active fund for this conversation only. Other conversations on the same connection keep their own.
- Every change names the fund the assistant believes is active (`activeFund`). A change naming a different fund is refused and nothing is written, so a switched fund can't be written to by mistake.
- In each fund the connection acts as that fund's own member, with that member's role, grants and entities. Linking never widens anyone's access, and each fund's admins can switch linking off.

## What it can see

The assistant acts as the person who connected it.

- Its **tool list is filtered** to the areas that person can read, the features the fund has turned on, and their role. A tool for an area they can't read isn't listed at all.
- Every call is **checked again** against their live grants, so a revoked grant takes effect on the next call.
- It sees only **their entities**: on a company two funds hold, a Fund I member's assistant sees Fund I's position and books, not Fund II's.
- Dashboards and custom views load each block with the viewer's access; a shared view never carries its author's.

## Documents and downloads

Ask for a document "as a PDF" (an LP's capital account statement, a report card or a batch of them, the performance report, the financial statements, a K-1, the tax package, a custom view as PDF or Excel) and the assistant hands back a link. A link works for **one hour** and only for the person who asked: opening it checks their access again, so a forwarded or stale link opens nothing.

To give the fund a file larger than a chat can carry, the assistant asks for a signed upload link, uploads the file there, then registers it.

## Limits

| Limit | Value |
| --- | --- |
| Calls per fund | 300 reads or 60 changes a minute |
| JSON-RPC batch | Each call in a batch counts against the limit |
| Access token (Claude, ChatGPT) | 1 hour, renewed automatically for up to 30 days |
| Download links | 1 hour, for the person who asked |
| Tool list | Fetched once per conversation by Claude and ChatGPT; a tool added since then is found with `search_tools` and run with `call_tool` |

Work that takes longer than a call (the memo agent, deal research, a long company update, a period close over many months) keeps running after the chat moves on. The tool returns a job, and the assistant checks on it when you ask. A long close stops at its time limit and says what remains; run it again to continue.

## What it can do

[MCP-TOOLS](./MCP-TOOLS.md) lists every tool by area, generated from the code, with whether it changes anything and what happens when a chat calls it. In short:

- **Portfolio**: companies, investments and marks, KPIs, company updates (pass one in chat and it goes through the same pipeline as an emailed update), fund holdings, cost transfers.
- **Books**: accounts, the journal (post, edit drafts, reverse), bank feed and reconciliation, periods and the close, statements as of any date, the waterfall, capital calls and distributions, receipts, the QuickBooks and Carta import.
- **LPs**: the register, commitments, capital accounts, live reports and report cards, statements on each basis, administrator figures, the portal and onboarding, letters.
- **Deals and diligence**: deal flow, the data room, the checklist, the memo agent, rounds, memos.
- **Forecast and construction**: plans, scenarios, variance, the Excel model.
- **Tax, compliance and admin**: book-to-tax adjustments, K-1s, the compliance calendar, setup, the team.
- **Dashboards and views**: the home dashboard, portfolio, company, statements, LP and capital-call dashboards, charts, saved dashboards and custom views.
- **Questions across the data**: for questions no named tool answers ("which companies did we invest in last year below a $20M valuation?"), the query tools filter and total the fund's own data within your access.
- **Audit**: outside firms' activity log, and notes filed into it.

[PARITY](./PARITY.md) records what the app can do that MCP and the API can't yet, and why.

## Troubleshooting

| What happens | Why, and what to do |
| --- | --- |
| The assistant says a tool doesn't exist | Its tool list was cached when the conversation began. Ask it to use `search_tools` and `call_tool`, or start a new conversation. If it still isn't there, your access or the fund's feature switches don't include that area. |
| "This credential is read-only" | The connection was approved as read only. Reconnect and choose read and change, or use a read-and-write API key. |
| A change comes back "staged" | That's expected from a chat. Approve it in the chat or on the Approvals page. |
| A change is refused as admin only | Ask an admin, or propose it from the chat so it waits for an admin. With an API key it is refused, since a key has no one to ask. |
| "Not found" for something you know exists | It belongs to an entity or area you weren't granted. An admin can change that under Settings → Team → Access. |
| A change is refused for naming the wrong fund | The conversation's active fund is a different one. Ask the assistant to run `list_funds`, switch with `use_fund` if needed, and try again. |
| A download link opens nothing | It is more than an hour old, or someone else opened it. Ask for a new one. |
| The connection stopped working | Agent access was switched off, your access ended, or the sign-in was revoked. Reconnect from the assistant's connector settings. |
| A dashboard shows as text only | That assistant can't draw dashboards here; the figures in the text are the same. |

## Investors' own assistants

Investors can connect Claude or ChatGPT to their LP portal when the fund turns on **Investor connector**. It is a separate connector with its own sign-in, covers only that investor's own investment in the one fund they chose, and everything it does shows in the LP activity log. See [DOCS](./DOCS.md#investors-connecting-their-own-assistant).
