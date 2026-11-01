# Fund Access

An open spec for who may do what with a venture fund's data when the people doing it are not all
the fund's own staff: fund administrators, tax preparers, auditors, compliance vendors and LPs,
each working through the web, an assistant (MCP) or a script (an API key). It comes with test
vectors and a small reference engine, so "implements Fund Access 0.1" is something anyone can check.

```
00-overview.md ... 08-not-in-scope.md   the spec, one page per section
schema/    the JSON Schema for a vector (draft 2020-12)
vectors/   43 test vectors, one JSON file each, grouped by what they test
engine/    the reference decision function, TypeScript, no dependencies
```

"Fund Access" is a working name. The spec is drafted inside Portfolio, its reference
implementation, so the two change together; it is written to stand on its own and can move to its
own repository.

## Why

A fund that lets outside firms and LPs into its systems has to answer the same handful of
questions, and the answers move real risk. Can the auditor post an entry, or only put one forward?
Can the fund administrator keep one fund's books and only read another's? When an assistant makes a
change, does it happen, or does it wait for a person? Is "hidden" hidden, or only gone from the
menu? Each door (the web app, MCP, the API) tends to answer these in its own code, and the answers
drift. Portfolio found three places where its doors disagreed by running them side by side.

Fund Access names each of those answers and ships a vector for it, so a door's behaviour is
something you can test rather than something you hope.

## A vector

```json
{
  "id": "proposer-assistant-not-staged",
  "fundAccess": "0.1",
  "title": "A proposal from an assistant runs at once, not staged",
  "tags": ["proposals"],
  "fund": {},
  "party": { "role": "member", "grants": { "accounting": "propose" }, "entities": "all" },
  "call": { "action": "write", "area": "accounting", "credential": "assistant", "proposable": true },
  "expect": { "outcome": "propose" }
}
```

## Running the vectors

In Portfolio, `npm test` runs `tests/fund-access-vectors.test.ts` (schema and reference engine) and
`tests/fund-access-portfolio.test.ts` (Portfolio's own checks). Another implementation writes an
adapter that turns a vector into its own terms and returns an outcome; see
[07-conformance.md](07-conformance.md).
