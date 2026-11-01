# Conformance

## What "implements Fund Access 0.1" means

An implementation conforms when, for every vector in `vectors/`, its own decision for the vector's
fund, party and call has the vector's `expect.outcome`. Reasons are advisory: an implementation
SHOULD refuse for the vector's reason, but words its refusals for its own users, and conformance
doesn't compare them.

The prose pages state further MUSTs (engagements, LP requests, records, doors) that 0.1 has no
vectors for. An implementation claiming 0.1 SHOULD meet them; vectors for them are planned.

## Vectors

Each vector is one JSON file, valid against `schema/vector.schema.json`:

- `fund`: the switches and defaults that differ from the standard (every switch `everyone`, no
  defaults);
- `party`: a role, grants by area, and entity scope (`all`, or entities with optional caps);
- `call`: the action, area, entity, credential, its scopes, and the operation's flags;
- `expect`: the outcome, and the reason when it's a refusal.

Vectors are grouped in folders by their first tag: `levels`, `proposals`, `staging`, `entities`,
`records`.

## Adapters

An implementation tests itself with an adapter: code that turns a vector into the
implementation's own terms (its access context, a credential, an operation with the vector's flags)
and returns the outcome its own checks give. The adapter MUST NOT re-decide a rule; it chooses
which of the implementation's checks the call passes through, in the order its doors run them. An
adapter that reimplements `decide` proves nothing.

Portfolio's adapter is `tests/fund-access-portfolio.test.ts`. It builds an `AccessContext` from the
vector and calls the functions Portfolio's doors call: `hasAccess` and `entityAccess` for the web,
`authorizeToolCall` for MCP and the API, `adminOnlyRefusal` and `shouldStage` for writes, and
`recordEntity` for filings. Portfolio passes all 43 vectors.

## The reference engine

`engine/decide.ts` passes every vector (`tests/fund-access-vectors.test.ts`, which also validates
each vector against the schema). When a vector and the prose disagree, that is a bug in one of
them, and the engine is how it's caught.
