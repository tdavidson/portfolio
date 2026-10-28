# Walter conformance

[Walter](https://github.com/tdavidson/walter) is an open spec for fund terms: the terms and dated
flows go in, every allocation the terms imply comes out, and a set of vectors says what the right
answer is. This folder runs Portfolio's accounting engine on those vectors.

- `adapter.ts` translates Walter's terms and flows into what the books hold and calls the engine
  (`splitDistribution`, `carryTarget`, `clawbackAtFundEnd`) for every number. It does no
  waterfall math of its own. A term the engine can't express is refused as `unsupported`.
  LP classes (Walter 0.2) become per-LP waterfall terms: the engine groups LPs on identical
  terms (`groupLpsByTerms`, `packages/fund-engine/src/lp-groups.ts`) and runs each group on its
  share. A class's fee rates are a group in `feeSchedule`. Walter 0.3's carry escrow runs through
  `CarryEscrow` (`packages/fund-engine/src/carry-escrow.ts`), and the net-of-tax clawback cap is
  `VehicleCarryTerms.clawbackNetOfTaxRate`, which `clawbackAtFundEnd` and `groupedClawback` apply.
- `vectors/` and `compare.ts` are copied from the Walter repo, unchanged. Copy them again when
  the spec moves.
- `conformance.test.ts` runs every vector in `npm test`. Each must pass unless it's in `GAPS`,
  with what the engine is missing.

To refresh the spec repo's compatibility table:

```
WALTER_RESULTS=../walter/results/portfolio-accounting.json npx vitest run lib/accounting/walter
```
