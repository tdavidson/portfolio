# Doors

A **door** is a way in: the web app, MCP for assistants, and an API for scripts. Fund Access
doesn't standardise a door's protocol. It standardises what a door must decide and show.

## Every door decides the same

The decision in [03-decisions.md](03-decisions.md) MUST be the same on every door. The way to keep
it so is to make one function decide for every door; the way to know it is so is to test the doors
against each other. Portfolio does both: one authorization function serves MCP, the API and staged
runs, and a test runs every preset through each web route and its matching tool.

## Tool lists

An assistant's tool list and the API's MUST show a party the same tools: a tool a party may call
in some form, including a proposable write for a proposer and a record tool for anyone who reads
some area. A tool the party can never call SHOULD be left out, so an assistant doesn't offer what
will be refused.

## What a staged change returns

A call that is staged or proposed MUST say so in its result, plainly enough that an assistant
doesn't report it as done: that nothing has changed yet, who may approve it, and where.

## Audit

Every change, proposal, approval and filing SHOULD carry the door it came through (`web`, `api`
or `mcp`) in the fund's audit trail.
