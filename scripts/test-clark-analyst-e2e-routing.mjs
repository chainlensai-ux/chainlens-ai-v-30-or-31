import assert from 'node:assert/strict'
import fs from 'node:fs'
import { classifyClarkAnalystIntent, isChainLensAnalystPrompt } from '../lib/server/clarkAnalystIntent.ts'
import { classifyClarkBasicIntent, buildClarkDirectAnswer, clarkMissingInputPrompt } from '../lib/server/clarkBasicIntent.ts'
import {
  classifyClarkPrompt,
  classifyClarkToolIntent,
  classifyWalletFollowupKind,
  classifyTokenFollowupKind,
  formatWalletFollowupFromMemory,
  isTokenFollowupPrompt,
  resolveClarkFollowupCommand,
  formatNewBasePoolReadFromCandidates,
  isNewBaseLaunchPrompt,
} from '../lib/server/clarkRouting.ts'
import { NEW_BASE_POOL_MAX_AGE_HOURS, rankBaseMarketCandidates } from '../lib/server/baseMarketUniverse.ts'

const wallet = `0x${'1'.repeat(40)}`
const token = `0x${'2'.repeat(40)}`

const domainMatrix = {
  wallet: [
    `Analyze this wallet: ${wallet}`,
    'Is this wallet profitable?',
    'What is this wallet’s realized PnL?',
    'Why is PnL partial?',
    'What tokens is this wallet holding?',
    'Best/worst trade?',
    'Biggest buys/sells?',
    'Is this wallet a whale/sniper/dev wallet?',
    'Explain wallet risk, coverage, excluded lots, missing evidence.',
  ],
  token: [
    `Scan this token: ${token}`,
    'Is this token safe to ape?',
    'Is this token a rug risk?',
    'Who controls supply?',
    'Is liquidity locked?',
    'Can the dev dump?',
    'Are holders concentrated?',
    'Explain LP risk, holder risk, contract risk, risk score.',
  ],
  pump: [
    'Why is this token pumping?',
    'Is the pump likely to continue?',
    'What could kill this pump?',
    'Show buy/sell pressure, liquidity change, volume acceleration, whale activity, top buyers/sellers.',
    'Is this pump organic or fake?',
    'What should I watch next?',
  ],
  radar: [
    'What is pumping on Base?',
    'Show new Base tokens.',
    'Which tokens have strong momentum?',
    'Which tokens have the strongest momentum?',
    'Why is rank 1 trending?',
    'Scan token number 3.',
  ],
  whale: [
    'Show latest whale alerts.',
    'What did whales buy/sell?',
    'Which wallets are accumulating?',
    'Explain this whale alert.',
    'Which alerts matter most?',
  ],
}

for (const [domain, prompts] of Object.entries(domainMatrix)) {
  for (const prompt of prompts) {
    const routed = classifyClarkAnalystIntent(prompt)
    assert.equal(routed.domain, domain, `${prompt} -> ${domain}, got ${routed.domain}/${routed.route}`)
    assert.equal(isChainLensAnalystPrompt(prompt), true, `${prompt} must bypass generic basic chat`)
    assert.notEqual(routed.route, 'unknown', `${prompt} needs a concrete ChainLens route`)
    assert.ok(routed.evidenceSource, `${prompt} needs an evidence source`)
  }
}

// Wallet scanner vs token scanner boundaries.
assert.equal(classifyClarkPrompt(`Analyze this wallet: ${wallet}`).intent, 'wallet_scan')
assert.equal(classifyClarkPrompt(`Scan this token: ${token}`).intent, 'token_scan')
assert.equal(clarkMissingInputPrompt(classifyClarkBasicIntent(`Analyze this wallet: ${wallet}`), `Analyze this wallet: ${wallet}`), null)
assert.equal(clarkMissingInputPrompt(classifyClarkBasicIntent(`Scan this token: ${token}`), `Scan this token: ${token}`), null)
assert.match(clarkMissingInputPrompt(classifyClarkBasicIntent('Analyze this wallet'), 'Analyze this wallet') ?? '', /wallet address/i)
assert.match(clarkMissingInputPrompt(classifyClarkBasicIntent('Scan this token'), 'Scan this token') ?? '', /token contract/i)

// Wallet read-model questions resolve to the correct evidence formatter.
assert.equal(classifyWalletFollowupKind('What is this wallet’s realized PnL?'), 'wallet_profitability')
assert.equal(classifyWalletFollowupKind('Why is PnL partial?'), 'wallet_pnl_explanation')
assert.equal(classifyWalletFollowupKind('What tokens is this wallet holding?'), 'wallet_holdings')
assert.equal(classifyWalletFollowupKind('Best/worst trade?'), 'wallet_trades')
assert.equal(classifyWalletFollowupKind('Biggest buys/sells?'), 'wallet_activity')
assert.equal(classifyWalletFollowupKind('Is this wallet a whale/sniper/dev wallet?'), 'wallet_profile')

const walletProfileRead = formatWalletFollowupFromMemory(wallet, {
  ok: true,
  totalValue: 300_000,
  holdings: [{ symbol: 'USDC', value: 300_000, chain: 'base' }],
  chainsActive: ['base'],
  walletProfile: { walletCategory: 'Whale', portfolioConfidence: 'high', tradingConfidence: 'low' },
}, 'wallet_profile')
assert.match(walletProfileRead, /Whale: Yes/)
assert.match(walletProfileRead, /Sniper: Open Check/)
assert.match(walletProfileRead, /Dev wallet: Open Check/)

// Token questions bind to token evidence, never wallet scanning.
for (const prompt of ['Is this token safe to ape?', 'Is this token a rug risk?', 'Who controls supply?', 'Is liquidity locked?', 'Can the dev dump?', 'Are holders concentrated?', 'Explain contract risk.']) {
  assert.notEqual(classifyClarkPrompt(prompt).intent, 'wallet_scan', `${prompt} must not route to Wallet Scanner`)
}
assert.equal(classifyTokenFollowupKind('Who controls supply?'), 'dev_rug')
assert.equal(classifyTokenFollowupKind('Can the dev dump?'), 'dev_rug')
assert.equal(classifyTokenFollowupKind('Are holders concentrated?'), 'risk')
assert.equal(isTokenFollowupPrompt('Explain contract risk.'), true)

// Base and Whale prompts hit their live/internal feeds.
assert.equal(classifyClarkPrompt('What is pumping on Base?').intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt('Show new Base tokens.').intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt('Which tokens have strong momentum?').intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt('Which tokens have the strongest momentum?').intent, 'base_market_discovery')
assert.equal(classifyClarkAnalystIntent('Which tokens have the strongest momentum?').route, 'base_market')

// "New Base tokens" is an age-verified pool query, never a renamed ecosystem/momentum list.
assert.equal(isNewBaseLaunchPrompt('Show new Base tokens.'), true)
const marketFixture = [
  { tokenAddress: token, poolAddress: `0x${'5'.repeat(40)}`, symbol: 'FRESH', name: 'Fresh', priceUsd: 1, change1h: 2, change6h: 5, change24h: 10, volume24h: 50_000, liquidityUsd: 25_000, fdv: null, marketCap: null, txns24h: 20, buys24h: 14, sells24h: 6, poolAgeHours: 2, dex: 'uniswap-v3', sourceTags: ['gt_new'], reasonTags: [] },
  { tokenAddress: `0x${'6'.repeat(40)}`, poolAddress: `0x${'7'.repeat(40)}`, symbol: 'OLD', name: 'Old', priceUsd: 1, change1h: 20, change6h: 30, change24h: 100, volume24h: 5_000_000, liquidityUsd: 2_000_000, fdv: null, marketCap: null, txns24h: 200, buys24h: 140, sells24h: 60, poolAgeHours: 24 * 365, dex: 'uniswap-v3', sourceTags: ['gt_trending'], reasonTags: [] },
  { tokenAddress: `0x${'8'.repeat(40)}`, poolAddress: null, symbol: 'UNKNOWN', name: 'Unknown', priceUsd: 1, change1h: null, change6h: null, change24h: 50, volume24h: 2_000_000, liquidityUsd: 1_000_000, fdv: null, marketCap: null, txns24h: null, buys24h: null, sells24h: null, poolAgeHours: null, dex: null, sourceTags: ['trending_feed'], reasonTags: [] },
]
const newOnly = rankBaseMarketCandidates(marketFixture, 'new_launches')
assert.deepEqual(newOnly.map((row) => row.symbol), ['FRESH'])
assert.ok(rankBaseMarketCandidates(marketFixture, 'pumping').some((row) => row.symbol === 'OLD'), 'age filtering applies only to new-launch discovery')
const newRead = formatNewBasePoolReadFromCandidates(newOnly.map((row) => ({ ...row, volume24hUsd: row.volume24h })), NEW_BASE_POOL_MAX_AGE_HOURS)
assert.match(newRead ?? '', /FRESH — 2\.0h old/)
assert.doesNotMatch(newRead ?? '', /OLD|UNKNOWN/)
assert.match(newRead ?? '', /Unknown-age pools were excluded/)
assert.equal(classifyClarkToolIntent('Show latest whale alerts.').intent, 'whale_alerts_recent')
assert.equal(classifyClarkToolIntent('What did whales buy/sell?').intent, 'whale_alerts_recent')
assert.equal(classifyClarkToolIntent('Which wallets are accumulating?').intent, 'whale_alerts_recent')
assert.equal(classifyClarkToolIntent('Explain this whale alert.').intent, 'whale_alerts_explain_signal')
assert.equal(classifyClarkToolIntent('Which alerts matter most?').intent, 'whale_alerts_summary')

// General ChainLens education is concise and deterministic, not a provider/model fallback.
for (const prompt of [
  'Explain verified PnL', 'Explain partial PnL', 'Explain liquidity risk',
  'Explain holder concentration', 'Explain CORTEX confidence', 'Explain Wallet Scanner',
  'Explain Token Scanner', 'Explain Base Radar', 'Explain Pump Alerts', 'Explain Whale Alerts',
]) {
  const route = classifyClarkAnalystIntent(prompt)
  assert.equal(route.route, 'education')
  const basic = classifyClarkBasicIntent(prompt)
  const answer = buildClarkDirectAnswer(basic, prompt)
  assert.ok(answer && answer.length > 20, `${prompt} needs a deterministic answer`)
  assert.doesNotMatch(answer, /I can help explain that/i, `${prompt} must not use generic filler`)
}

// Follow-up context: scan it, rank selection, safety, and risk explanation.
const marketItems = [
  { rank: 1, symbol: 'ONE', tokenAddress: token },
  { rank: 2, symbol: 'TWO', tokenAddress: `0x${'3'.repeat(40)}` },
  { rank: 3, symbol: 'THREE', tokenAddress: `0x${'4'.repeat(40)}` },
]
assert.equal(resolveClarkFollowupCommand('scan it', { route: '/terminal/token-scanner', tokenSummary: { address: token } }, []).intent, 'rescan_current_token')
assert.equal(resolveClarkFollowupCommand('scan it', { route: '/terminal/wallet-scanner', walletSummary: { address: wallet } }, []).intent, 'rescan_current_wallet')
assert.equal(resolveClarkFollowupCommand('open number 2', { marketContext: { items: marketItems } }, []).address, marketItems[1].tokenAddress)
assert.equal(resolveClarkFollowupCommand('scan token number 3', { marketContext: { items: marketItems } }, []).address, marketItems[2].tokenAddress)
assert.equal(resolveClarkFollowupCommand('why is rank 1 trending?', { marketContext: { items: marketItems } }, []).intent, 'explain_rank_momentum')
assert.equal(isTokenFollowupPrompt('is it safe?'), true)
assert.equal(isTokenFollowupPrompt('explain the risk'), true)

// Route wiring: audited classifier guards the basic shortcut, pump analysis uses its live report,
// and bare "why?" resolves from session evidence rather than generic chat.
const routeSource = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
assert.match(routeSource, /isChainLensAnalystPrompt\(prompt\)/)
assert.match(routeSource, /handlePumpIntelligenceQuestion/)
assert.match(routeSource, /pump_intelligence_report/)
assert.match(routeSource, /\^\\s\*why\\\?\?\\s\*\$/)
assert.ok(routeSource.indexOf('const wantsNewBasePools = isNewBaseLaunchPrompt(prompt)') < routeSource.indexOf('const cgTrending = await fetchCoinGeckoBaseTrending()'), 'new-pool routing must bypass the CoinGecko ecosystem mover list')

// WORD-BOUNDARY BUG, DISCLOSED (reported live: "why is this token pumping 0x...B200...2001" fell
// through to the generic Base market list instead of a token-specific pump analysis). Root cause:
// explicitPumpQuestion used a bare \bpump\b, whose trailing boundary requires a non-word character
// right after "pump" — "pumping" has "ing" there instead, so it never matched. Assert the fixed
// pattern is live and the old bare form is gone, checked against source with `//` comment lines
// stripped so this disclosure text itself (which necessarily contains the old literal) can't
// false-positive the "must be gone" check.
assert.match(routeSource, /\\bpump\(\?:ing\|s\)\?\\b/, 'explicitPumpQuestion must recognize "pumping"/"pumps", not just bare "pump"')
const routeSourceNoComments = routeSource
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')
assert.doesNotMatch(routeSourceNoComments, /\\bpump\\b(?!\(\?:ing)/, 'the old bare \\bpump\\b gate must not still be live (it silently misses "pumping")')
{
  const reportedPrompt = 'why is this token pumping 0xB2000000000000000000006B683a4612a94d2001'
  const explicitPumpQuestion = /\[mode:\s*pump-alerts\]|\bpump(?:ing|s)?\b|buy\/?sell\s+pressure|buy\s+and\s+sell\s+pressure|liquidity\s+change|volume\s+acceleration|top\s+buyers?\/?sellers?|top\s+buyers?\s+and\s+sellers?|organic\s+or\s+fake/i
  assert.equal(explicitPumpQuestion.test(reportedPrompt), true, 'the exact reported prompt must be recognized as an explicit pump question')
  assert.equal(explicitPumpQuestion.test('will this pump continue'), true)
  assert.equal(explicitPumpQuestion.test('is this pump organic or fake'), true)
}

// The V2 adapter must not discard live portfolio/canonical PnL evidence before Clark sees it.
const v2AdapterSource = fs.readFileSync(new URL('../lib/server/v2Adapters.ts', import.meta.url), 'utf8')
for (const field of ['totalValue', 'holdings:', 'walletTokenPnlRead', 'walletTradeStatsSummary', 'publicPnlStatus', 'walletProfile']) {
  assert.ok(v2AdapterSource.includes(field), `V2 Clark wallet projection must preserve ${field}`)
}

console.log('Clark analyst end-to-end routing matrix passed')
