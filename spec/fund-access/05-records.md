# Records

An MCP server sees tool calls, not the conversation around them. When an auditor's assistant works
through the journal with them, or the fund administrator's assistant reconciles a quarter, what was
concluded exists only in the chat, which the fund doesn't own and can't search. A **record** is how
it becomes the fund's.

## What a record is

A record has an area, an entity (or none, for fund-wide), a kind (`summary`, `decision`, `memo`,
`transcript` or `note`), a title and a body. It MAY point at the one thing it's about: a company,
an LP investor, a journal entry or a deal. An implementation MUST keep who filed it, when, through
which door, and the engagement they were working under.

Records are append-only. An implementation MUST NOT offer a way to edit or delete one through
any door; a correction is a new record.

## Who may file

Filing needs read in the record's area, not write: a record is the fund's note of what was
concluded about things the party can already see, and it changes nothing else. So an auditor with
`propose` on accounting files a journal review there, and a tax preparer files into tax.

The decision is step 5 of [03-decisions.md](03-decisions.md). In short: a credential with write
scope, a role other than observer, read in the area, and the entity in scope. A fund-wide record
needs a party who sees every entity. Filing is never staged, because there is nothing to approve.

## Who may read

A record is visible to a party with read in its area who sees its entity. A fund-wide record is
visible only to a party who sees every entity. Lists MUST leave out what a party can't see, and a
request for one by id MUST answer the same way whether it doesn't exist or isn't theirs.

## Assistants

An implementation SHOULD offer three tools: one to file a record, one to list records (by area,
entity, subject or text, without bodies) and one to read a record. The filing tool's description
SHOULD ask the assistant to show the person the title and body before filing.
