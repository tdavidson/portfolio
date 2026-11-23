// The implementation lives in the open fund engine: packages/fund-engine/src/distribution-waterfall.ts
// (@portfolio/fund-engine). This module re-exports it so existing imports keep working; change the
// math there, not here.

export {
  ZERO_TIERS,
  lineBreakdown,
  replayWaterfallState,
  splitDistribution,
  suggestedCharacter,
} from '@portfolio/fund-engine'
export type {
  LineBreakdown,
  PartnerEconomics,
  PriorDistribution,
  SplitMethod,
  WaterfallTiers,
  DistributionSplit,
  SplitInput,
} from '@portfolio/fund-engine'
