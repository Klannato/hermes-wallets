/**
 * Render the real desktop/plugin.js to static HTML against a stubbed SDK and a
 * synthetic fixture, then assert the pane's structure. No app, no browser, no
 * network: catches "the pane throws on render" and "a row silently broke".
 *
 * `react` / `react-dom` are resolved from the CURRENT DIRECTORY — the Hermes
 * desktop app folder ships them, this repo deliberately has no node_modules:
 *
 *   cd ~/.hermes/hermes-agent/apps/desktop
 *   node /path/to/hermes-wallets/dev/render-check.mjs
 *
 * Or point WALLETS_APP_DIR at any folder that has react installed.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const appDir = process.env.WALLETS_APP_DIR || process.cwd()
const require = createRequire(path.join(appDir, 'package.json'))

let React
let renderToStaticMarkup
try {
  React = require('react')
  ;({ renderToStaticMarkup } = require('react-dom/server'))
} catch {
  console.error(
    'Cannot resolve react/react-dom from ' + appDir + '\n' +
      'Run this from the Hermes desktop app folder (apps/desktop), or set WALLETS_APP_DIR.'
  )
  process.exit(2)
}

// The plugin imports `react/jsx-runtime`, which only resolves from a folder that
// has it — so the instrumented copy lives beside the app, not in the repo.
const sdkUrl = new URL('./sdk-stub.mjs', import.meta.url).href
const source = new URL('../desktop/plugin.js', import.meta.url)
const instrumented = readFileSync(source, 'utf8').replace("from '@hermes/plugin-sdk'", `from '${sdkUrl}'`)
const underTestPath = path.join(appDir, `.wallets-render-check-${process.pid}.mjs`)
writeFileSync(underTestPath, instrumented, 'utf8')
process.on('exit', () => {
  try {
    unlinkSync(underTestPath)
  } catch {
    /* already gone */
  }
})

const sdk = await import(sdkUrl)
const plugin = (await import(new URL(`file://${underTestPath}`).href)).default

// 2. fixture shaped exactly like /api/plugins/wallets/state
const model = (over) => ({
  id: 'deepseek/deepseek-v4.1-flash-1017',
  short: 'deepseek-v4.1-flash-1017',
  vendor: 'deepseek',
  pin: 0.075,
  pout: 0.3,
  blended: 0.131,
  ratio: 0.12,
  value: 0.74,
  grade: 'good',
  ctx: 1048576,
  tags: ['reasoning', 'tool-use'],
  blurb: 'reasoning · tool calls · 1.0M ctx',
  current: false,
  sale: null,
  nousIn: 0.11,
  nousOut: 0.51,
  cheaper: 'vercel',
  peak: { inPeak: true, multiplier: 2, until: '04:00', peakWindow: '01:00-04:00Z' },
  ...over
})

const fixture = {
  ts: 0,
  fetchedAt: '21:30:00',
  total: 24.66,
  currency: 'USD',
  active: { wallet: 'vercel', provider: 'vercel', model: 'deepseek/deepseek-v4.1-flash-1017', source: 'session' },
  primaryWallet: 'vercel',
  fallbackWallets: ['nous'],
  // New shape: every configured provider, active first. Three cards on purpose —
  // one balance-less marketplace and one depleted wallet exercise those states.
  wallets: [
    {
      id: 'vercel', name: 'Vercel AI Gateway', provider: 'ai-gateway', hasBalance: true,
      ok: true, balance: 4.24, subscriptionUsd: null, purchasedUsd: null,
      monthSpent: null, monthCap: null, totalUsed: 0.76, keyHint: 'vck_…example', tier: null, error: null,
      spent24h: 0.68, spent7d: 0.68, burn: { perHour: 0.5179, perDay: 12.43, windowMin: 91, samples: 16 },
      runwayDays: 0.3, runwayHours: 8.2, role: 'active',
      topUp: { url: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F~%2Fai-gateway', label: 'add credit' }
    },
    {
      id: 'nous', name: 'Nous Portal', provider: 'nous', hasBalance: true,
      ok: true, balance: 19.38, subscriptionUsd: 0, purchasedUsd: 19.38,
      monthSpent: 0.5, monthCap: 1000, totalUsed: null, keyHint: null, tier: 'New', error: null,
      spent24h: 0.5, spent7d: 0.5, burn: { perHour: 0.3318, perDay: 7.964, windowMin: 91, samples: 16 },
      runwayDays: 2.4, runwayHours: 58.4, role: 'fallback',
      topUp: { url: 'https://portal.nousresearch.com/billing?topup=open', label: 'add credit', minUsd: 5 }
    },
    {
      id: 'openrouter', name: 'OpenRouter', provider: 'openrouter', hasBalance: false,
      ok: false, balance: null, error: null, note: 'no balance API — usage is metered where you bought the key',
      spent24h: null, spent7d: null, burn: null, runwayDays: null, runwayHours: null, role: null,
      topUp: { url: 'https://openrouter.ai/settings/credits', label: 'add credit' }
    }
  ],
  picks: {
    ok: true, count: 258, avg: 1.125, saleCount: 31, salesByWallet: { nous: 28, vercel: 3 },
    tiers: [
      { key: 'dirt', label: 'dirt cheap', model: model({ id: 'alibaba/qwen3.7-flash', short: 'qwen3.7-flash', vendor: 'alibaba', pin: 0.03, pout: 0.13, ratio: 0.05, value: 0.56 }) },
      { key: 'cheap', label: 'cheap', model: model({ id: 'muse/muse-spark-1.2-contributor', short: 'muse-spark-1.2-contributor', vendor: 'muse', pin: 0.1, pout: 0.2, ratio: 0.11, value: 0.76 }) },
      { key: 'mid', label: 'mid', model: model({ id: 'nvidia/nemotron-3.5-super-vl', short: 'nemotron-3.5-super-vl', vendor: 'nvidia', pin: 0.2, pout: 0.5, ratio: 0.24, value: 0.62 }) },
      { key: 'upper', label: 'capable', model: model({ id: 'amazon/nova-2-lite', short: 'nova-2-lite', vendor: 'amazon', pin: 0.3, pout: 2.5, ratio: 0.76, value: 0.42 }) },
      { key: 'frontier', label: 'frontier', model: model({ id: 'alibaba/qwen3.8-max-prime', short: 'qwen3.8-max-prime', vendor: 'alibaba', pin: 4, pout: 12, ratio: 5.33, value: 0.01, grade: 'premium', peak: null }) }
    ],
    sales: [
      model({ id: 'mistralai/mistral-nemo', short: 'mistral-nemo', vendor: 'mistral', pin: 0.03, pout: 0.03, ratio: 0.03, value: 0.06, grade: 'premium', sale: { pct: 88, wallet: 'nous', list: 0.15 }, peak: null, cheaper: 'nous' }),
      model({ id: 'alibaba/qwen3-next-80b-a3b-thinking', short: 'qwen3-next-80b-a3b-thinking', vendor: 'alibaba', pin: 0.15, pout: 1.2, ratio: 0.37, value: 0.07, grade: 'premium', sale: { pct: 78, wallet: 'vercel', list: 1.88 }, peak: null, cheaper: 'vercel' }),
      model({ id: 'deepseek/deepseek-v4-flash-0731', short: 'deepseek-v4-flash-0731', vendor: 'deepseek', pin: 0.08, pout: 0.15, ratio: 0.09, value: 0.4, sale: { pct: 64, wallet: 'vercel', list: 0.26 }, peak: null, cheaper: 'vercel' })
    ],
    current: model({ current: true, blurb: 'your current pick · 1.0M ctx' })
  }
}

sdk.__setQueryData(fixture)

// 3. capture what the plugin registers, then render the pane
const registered = []
plugin.register({
  rest: async () => fixture,
  os: { openExternal: () => true, writeClipboard: () => Promise.resolve(true) },
  storage: { get: (_k, fallback) => fallback, set: () => {}, remove: () => {} },
  register: (contribution) => registered.push(contribution),
  i18n: { register: () => {} }
})

const pane = registered.find((r) => r.id === 'pane')
const chip = registered.find((r) => r.id === 'chip')
console.log('registered:', registered.map((r) => r.id).join(', '))

const html = renderToStaticMarkup(React.createElement(pane.render))
const chipHtml = renderToStaticMarkup(React.createElement(chip.render))

const checks = [
  ['pane renders', html.length > 500],
  ['every configured wallet has a card', html.includes('Nous Portal') && html.includes('Vercel AI Gateway') && html.includes('OpenRouter')],
  ['balance-less wallet explains itself', html.includes('no balance API')],
  ['per-wallet carets', (html.match(/[▾▸]/g) || []).length >= 4],
  ['model picks header', html.includes('model picks')],
  ['on sale section', html.includes('on sale')],
  ['collapse carets present', (html.match(/[▾▸]/g) || []).length >= 2],
  ['verbose price label', html.includes('in $0.03 / out $0.13')],
  ['ratio vs median label', html.includes('× median price')],
  ['sale tag names wallet', html.includes('▼88% on Nous') && html.includes('▼78% on Vercel')],
  ['cheaper marker', html.includes('cheaper on Nous')],
  ['per-wallet sale counts', html.includes('28 Nous · 3 Vercel')],
  ['spend rate row', html.includes('$0.52/hr')],
  ['per-minute row', html.includes('/min')],
  ['runway row', html.includes('8.2 hours') && html.includes('2.4 days')],
  ['peak tag', html.includes('peak ×2 until 04:00Z')],
  ['add credit per wallet', (html.match(/add credit/g) || []).length >= 3],
  ['nous min shown', html.includes('min $5')],
  ['vercel topup url wired', html.includes('vercel.com/d?to=')],
  ['chip renders', chipHtml.includes('$24.66')]
]
let ok = true
for (const [name, pass] of checks) {
  if (!pass) ok = false
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
}
console.log('\nhtml length:', html.length, '| chip:', chipHtml)
process.exitCode = ok ? 0 : 1
