// The `help` tool's topics, apart from its content so the manifest (which the Settings UI imports)
// stays free of the catalogs behind them.

export const HELP_TOPICS = [
  'overview', 'views', 'starters', 'dashboards', 'charts', 'exports', 'approvals', 'funds',
  'portfolio', 'books', 'lps', 'forecast', 'deals', 'diligence',
] as const
export type HelpTopic = (typeof HELP_TOPICS)[number]

/** The topics that are areas of the fund (lib/agent/getting-started.ts AREAS keys). */
export const AREA_TOPICS: readonly HelpTopic[] = ['portfolio', 'books', 'lps', 'forecast', 'deals', 'diligence']
