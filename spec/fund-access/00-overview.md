# Fund Access 0.1

Fund Access describes how a fund decides whether a request to read or change its data goes ahead.
The fund owns the data. Its own staff run it; outside firms and LPs reach the parts they are given,
through whichever door they use. The spec has three parts, meant to be read together.

- **The spec**, these pages: what every term means and the order in which a decision is made.
- **The test vectors** in `vectors/`. Each holds a fund's switches, one party's grants and one
  call, and the outcome. Prose can be read two ways; a vector can't.
- **The reference engine** in `engine/decide.ts`, about a hundred lines that pass every vector. It
  shows the vectors agree with each other, and is not the only way to run them.

## The idea in one paragraph

A request comes from a **party** (an admin, a member, an observer, an LP) through a **credential**
(a person signed in, an assistant, a script) and makes a **call**: read, write or file a record, in
one **area** of the fund (accounting, tax, compliance and so on), usually on one **entity** (a fund
vehicle). The party's **level** in that area, lowered by any **cap** on that entity, decides
whether the call may happen at all. The credential decides how: a person's write happens, an
assistant's write waits for its person to approve it, a proposer's write becomes a **proposal** for
someone with write to accept. The same party making the same call gets the same outcome on every
door.

## Scope

0.1 covers:

- areas, the four levels (none, read, propose, write) and how areas relate to each other;
- the fund's switch per area, which nobody clears, admins included;
- members' grants, the fund's defaults, and the read-only observer;
- entity scope and per-entity caps;
- the decision for a read, a write and a record filing, including proposals, staging for approval
  and admin-only writes;
- engagements for outside firms, LP change requests and fund records, as behaviour (vectors for
  these come in 0.2).

What it leaves out is in [08-not-in-scope.md](08-not-in-scope.md).

## Reading order

| Page | What it covers |
| --- | --- |
| [01-areas-and-levels.md](01-areas-and-levels.md) | The standard areas, levels, switches, defaults and how areas relate |
| [02-parties-and-entities.md](02-parties-and-entities.md) | Roles, grants, presets for outside firms, engagements, entity scope and caps |
| [03-decisions.md](03-decisions.md) | The decision for one call, step by step |
| [04-lp-requests.md](04-lp-requests.md) | What an LP may see and ask to change, and who approves |
| [05-records.md](05-records.md) | Filing what a session concluded, and who may read it |
| [06-doors.md](06-doors.md) | The web, MCP and the API, and what each must expose |
| [07-conformance.md](07-conformance.md) | Vectors, adapters and what "implements 0.1" means |
| [08-not-in-scope.md](08-not-in-scope.md) | What 0.1 doesn't cover |

## Conformance language

MUST, SHOULD and MAY are used as in RFC 2119. Anything not marked MUST is guidance.
