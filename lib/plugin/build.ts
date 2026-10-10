// Builds the plugin a member installs in Claude or ChatGPT to reach THIS deployment.
//
// WHY THE APP BUILDS IT, PER DEPLOYMENT. A plugin is skills plus a connector, and both assistants
// require the connector's address to be fixed inside the package: neither lets the person
// installing it type a server URL, and Claude's chat surface ignores a templated one. This app is
// self-hosted, one deployment per fund, so there is no single address a published plugin could
// carry. The deployment that will answer is the only thing that knows its own URL, so it writes
// that URL into the package and hands it to its own members.
//
// The package holds no credential and no fund data: the manifest, the connector's address, and
// the skills (plugin/, embedded by scripts/build-mcp-app.mjs). Signing in happens afterwards,
// through this deployment's OAuth flow, as the person connecting.

import JSZip from 'jszip'
import { PLUGIN_FILES } from './plugin-files.generated'

export const PLUGIN_TARGETS = ['claude', 'chatgpt'] as const
export type PluginTarget = (typeof PLUGIN_TARGETS)[number]

export function isPluginTarget(value: unknown): value is PluginTarget {
  return typeof value === 'string' && (PLUGIN_TARGETS as readonly string[]).includes(value)
}

export interface PluginContext {
  /** This deployment's origin as the member reached it, e.g. https://portfolio.example.vc */
  origin: string
  /** The fund's name, for the label people see. Null falls back to the product's. */
  fundName: string | null
  /** The app's version; the plugin is versioned with the deployment that built it. */
  version: string
}

const DESCRIPTION =
  'See your fund in the conversation: the portfolio, a company and its KPIs, the financial statements and LP capital as interactive dashboards, saved to reopen any time, with answers drawn from the same figures.'

/** The MCP endpoint a plugin built here points at. */
export function connectorUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/mcp`
}

/**
 * The plugin's permanent identity, unique to this deployment.
 *
 * Both assistants key an installed plugin on its `name`. Two funds' packages sharing one name
 * would be the same plugin to anyone who belongs to both, and the second install would replace
 * the first one's connector. The host is what tells deployments apart, so the host is in the name.
 */
export function pluginName(origin: string): string {
  let host = origin
  try { host = new URL(origin).host } catch { /* not a URL: slug whatever we were given */ }
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  // Kebab-case, and short enough for either directory's limit with the prefix on.
  return `portfolio-${slug || 'deployment'}`.slice(0, 64).replace(/-+$/, '')
}

function displayName(fundName: string | null): string {
  const fund = fundName?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return fund ? `${fund.slice(0, 60)} Portfolio` : 'Portfolio'
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** The static files (skills, README) with this deployment's connector noted in the README. */
function sharedFiles(ctx: PluginContext): Record<string, string> {
  const files = { ...PLUGIN_FILES }
  files['README.md'] = `${(files['README.md'] ?? '# Portfolio\n').trimEnd()}\n\n## Connector\n\nThis package connects to \`${connectorUrl(ctx.origin)}\`.\n`
  return files
}

/**
 * Claude: `.claude-plugin/plugin.json` and `.mcp.json` beside `skills/`.
 * https://claude.com/docs/plugins/build
 */
function claudeFiles(ctx: PluginContext): Record<string, string> {
  const author = ctx.fundName?.trim() || 'Portfolio'
  return {
    ...sharedFiles(ctx),
    '.claude-plugin/plugin.json': json({
      name: pluginName(ctx.origin),
      displayName: displayName(ctx.fundName),
      version: ctx.version,
      description: DESCRIPTION,
      author: { name: author, url: ctx.origin },
      homepage: ctx.origin,
      license: 'Apache-2.0',
      keywords: ['venture capital', 'fund', 'portfolio', 'dashboards', 'lp reporting'],
    }),
    // A fixed https URL and nothing else: no key, no header. Each person who installs the plugin
    // connects it and signs in as themselves.
    '.mcp.json': json({
      mcpServers: {
        portfolio: { type: 'http', url: connectorUrl(ctx.origin) },
      },
    }),
  }
}

/**
 * ChatGPT (and Codex): `plugin.json` and `mcp.json` at the root beside `skills/`.
 * https://developers.openai.com/plugins/build/plugins
 */
function chatgptFiles(ctx: PluginContext): Record<string, string> {
  const origin = ctx.origin.replace(/\/+$/, '')
  const label = displayName(ctx.fundName)
  return {
    ...sharedFiles(ctx),
    'plugin.json': json({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: pluginName(ctx.origin),
      version: ctx.version,
      description: DESCRIPTION,
      author: { name: ctx.fundName?.trim() || 'Portfolio', url: origin },
      homepage: origin,
      license: 'Apache-2.0',
      keywords: ['venture capital', 'fund', 'portfolio', 'dashboards', 'lp reporting'],
      extensions: {
        'com.openai': {
          interface: {
            displayName: label,
            shortDescription: 'Your fund\'s dashboards and figures in the conversation',
            longDescription: DESCRIPTION,
            developerName: ctx.fundName?.trim() || 'Portfolio',
            category: 'Productivity',
            capabilities: ['Read', 'Write'],
            websiteURL: origin,
            defaultPrompt: [
              'Show me the portfolio.',
              'Pull up the financial statements for last quarter.',
              'Who has funded their capital calls?',
            ],
          },
        },
      },
    }),
    'mcp.json': json({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        portfolio: {
          type: 'streamable-http',
          url: connectorUrl(ctx.origin),
          extensions: {
            'com.openai': {
              // This deployment registers each client on request (RFC 7591), so no client id
              // is shipped: app/api/oauth/register.
              auth: { type: 'oauth', client: { mode: 'dcr' }, registrationUrl: `${origin}/api/oauth/register` },
            },
          },
        },
      },
    }),
  }
}

/** Every file in the package, by path. */
export function pluginFiles(target: PluginTarget, ctx: PluginContext): Record<string, string> {
  return target === 'claude' ? claudeFiles(ctx) : chatgptFiles(ctx)
}

/** The package as a zip with the plugin at its root, which is what both assistants accept. */
export async function pluginZip(target: PluginTarget, ctx: PluginContext): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [path, contents] of Object.entries(pluginFiles(target, ctx))) zip.file(path, contents)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export function pluginFilename(target: PluginTarget, ctx: PluginContext): string {
  return `${pluginName(ctx.origin)}-${target}.zip`
}
