import assert from 'node:assert/strict'
import {
  classifyClarkToolIntent,
  isClarkWatchlistAddCommand,
} from '../lib/server/clarkRouting.ts'
import { classifyClarkBasicIntent, clarkMissingInputPrompt } from '../lib/server/clarkBasicIntent.ts'

// ─── Base Radar tool intent routing ───────────────────────────────────────
// PUMPING-VS-RADAR SPLIT, DISCLOSED (reported live: "what's pumping on Base?" answered with Base
// Radar's own internal feed/scoring even though base_market_discovery was already wired to an
// independent CoinGecko source — root cause traced to THIS classifier running first and treating
// "pumping"/"trending"/"movers" as radar triggers, so those prompts never reached the later,
// correct routing at all). Updated: "pumping"/"trending"/"movers"/"tokens"/"volume-liquidity"
// phrasing WITHOUT the literal word "radar" now returns 'none' here so it falls through to
// app/api/clark/route.ts's base_market_discovery branch (CoinGecko-backed) — see that test's own
// coverage in scripts/test-clark-market-metric-routing.mjs. Only unambiguous radar-specific
// phrasing stays routed to base_radar_movers.
assert.equal(classifyClarkToolIntent("What's pumping on Base?").intent, 'none', 'a bare "what\'s pumping" question must fall through to base_market_discovery (CoinGecko), not Base Radar\'s own feed')
assert.equal(classifyClarkToolIntent('Show me Base movers').intent, 'none')
assert.equal(classifyClarkToolIntent('Find new Base tokens').intent, 'none')
assert.equal(classifyClarkToolIntent("What's trending on Base?").intent, 'none')
assert.equal(classifyClarkToolIntent('Find tokens with high volume/liquidity').intent, 'none')
assert.equal(classifyClarkToolIntent('What are the best radar candidates?').intent, 'base_radar_movers', 'explicit "radar" wording must still route to Base Radar\'s own feed')
assert.equal(classifyClarkToolIntent('Open the radar').intent, 'base_radar_movers')
assert.equal(classifyClarkToolIntent('Base radar').intent, 'base_radar_movers')
assert.equal(classifyClarkToolIntent('Any low caps on Base?').intent, 'base_radar_low_caps')
assert.equal(classifyClarkToolIntent('Show Robinhood Chain movers').intent, 'base_radar_robinhood')
assert.equal(classifyClarkToolIntent('Explain this radar candidate').intent, 'base_radar_explain_candidate')
assert.equal(classifyClarkToolIntent('why is it on radar').intent, 'base_radar_explain_candidate')

// ─── Whale Alerts tool intent routing ─────────────────────────────────────
assert.equal(classifyClarkToolIntent('Any whale alerts?').intent, 'whale_alerts_summary')
assert.equal(classifyClarkToolIntent('Show whale movement').intent, 'whale_alerts_summary')
assert.equal(classifyClarkToolIntent('Sync whale alerts').intent, 'whale_alerts_sync')
assert.equal(classifyClarkToolIntent('Refresh whale alerts').intent, 'whale_alerts_sync')
assert.equal(classifyClarkToolIntent('What wallets moved recently?').intent, 'whale_alerts_recent')
assert.equal(classifyClarkToolIntent('Any big buys/sells?').intent, 'whale_alerts_recent')
assert.equal(classifyClarkToolIntent('What happened in whale alerts today?').intent, 'whale_alerts_recent')
assert.equal(classifyClarkToolIntent('Explain this whale signal').intent, 'whale_alerts_explain_signal')

// ─── Directional whale intents ────────────────────────────────────────────
// DISCLOSED (reported live): "What are whales buying" matched NO tool intent, so it fell through
// to the older LLM whale path, which reads the same stored feed but can never run a wallet sync —
// so an empty stored feed dead-ended there exactly like the plain feed question did. These route
// to handleClarkWhaleToolCall's real fetch -> broaden -> sync recovery ladder instead.
assert.equal(classifyClarkToolIntent('What are whales buying').intent, 'whale_alerts_buying')
assert.equal(classifyClarkToolIntent('what are whales buying?').intent, 'whale_alerts_buying')
assert.equal(classifyClarkToolIntent('What are Base whales buying').intent, 'whale_alerts_buying')
assert.equal(classifyClarkToolIntent('whale buys').intent, 'whale_alerts_buying')
assert.equal(classifyClarkToolIntent('what are smart money buying').intent, 'whale_alerts_buying')
assert.equal(classifyClarkToolIntent('what are whales accumulating').intent, 'whale_alerts_buying')
assert.equal(classifyClarkToolIntent('are whales selling').intent, 'whale_alerts_selling')
assert.equal(classifyClarkToolIntent('whales dumping').intent, 'whale_alerts_selling')
assert.equal(classifyClarkToolIntent('sell-side whale pressure').intent, 'whale_alerts_selling')
// The reported feed question must keep its existing routing, unchanged.
// MERGE NOTE, DISCLOSED: a concurrent fix independently added "latest whale alerts" to
// WHALE_RECENT_RE, so this now classifies as whale_alerts_recent rather than _summary — both
// intents fall through to the exact same resolveClarkWhaleFeed() ladder in
// handleClarkWhaleToolCall (only explain_signal/sync/buying/selling get their own branch), so this
// is a routing-label change only, not a behavior change for the reported prompt.
assert.equal(classifyClarkToolIntent('Show the latest whale alerts').intent, 'whale_alerts_recent')
// Directional matchers must never steal the more specific sync/explain/recent phrasings above.
assert.equal(classifyClarkToolIntent('sync whale alerts').intent, 'whale_alerts_sync')
assert.equal(classifyClarkToolIntent('explain that whale alert').intent, 'whale_alerts_explain_signal')
assert.equal(classifyClarkToolIntent('Any big buys/sells?').intent, 'whale_alerts_recent')
// Non-whale buying questions must NOT be captured by the new directional matchers.
assert.equal(classifyClarkToolIntent('should i buy this token').intent, 'none')
assert.equal(classifyClarkToolIntent('what are people buying').intent, 'none')

// ─── Never routes to generic chat (none) for these explicit phrasings ─────
for (const p of [
  'Any low caps on Base?', 'Show Robinhood Chain movers', 'What are the best radar candidates?',
  'Open the radar', 'Base radar', 'Any whale alerts?', 'Sync whale alerts', 'Show whale movement',
  'What wallets moved recently?', 'Any big buys/sells?', 'Refresh whale alerts', 'What happened in whale alerts today?',
]) {
  assert.notEqual(classifyClarkToolIntent(p).intent, 'none', `"${p}" must not fall through to generic chat`)
}

// ─── DOES route to generic-chat 'none' for pumping/trending phrasing WITHOUT "radar" — this is
// the fix itself: these must escape classifyClarkToolIntent so base_market_discovery (CoinGecko)
// gets a chance to answer them, instead of Base Radar's own feed. ─────────────────────────────
for (const p of [
  "What's pumping on Base?", 'Show me Base movers', 'Find new Base tokens',
  "What's trending on Base?", 'Find tokens with high volume/liquidity',
]) {
  assert.equal(classifyClarkToolIntent(p).intent, 'none', `"${p}" must fall through to base_market_discovery, not Base Radar`)
}

// ─── Irrelevant prompts stay "none" (never hijack unrelated intents) ──────
assert.equal(classifyClarkToolIntent('scan this wallet 0x1234567890abcdef1234567890abcdef12345678').intent, 'none')
assert.equal(classifyClarkToolIntent('is this token safe').intent, 'none')
assert.equal(classifyClarkToolIntent('hello').intent, 'none')

// ─── Watchlist add command ─────────────────────────────────────────────────
assert.equal(isClarkWatchlistAddCommand('add that to watchlist'), true)
assert.equal(isClarkWatchlistAddCommand('add this to my watchlist'), true)
assert.equal(isClarkWatchlistAddCommand('watch that'), true)
assert.equal(isClarkWatchlistAddCommand("what's pumping on base"), false)

// ─── Missing-input behavior (existing basic-intent gate, reused unchanged) ─
{
  const intent = classifyClarkBasicIntent('analyze this wallet')
  assert.equal(intent, 'wallet_scan_request', 'analyze this wallet with no address should ask for a wallet')
  const ask = clarkMissingInputPrompt(intent, 'analyze this wallet')
  assert.ok(ask && /wallet/i.test(ask), 'must ask for a wallet address')
}
{
  const intent = classifyClarkBasicIntent('scan this')
  assert.ok(
    intent === 'token_scan_request' || intent === 'wallet_scan_request' || intent === 'ambiguous_scan_request' || intent === 'unsupported_request',
    '"scan this" with no context must not silently answer as if a target were known',
  )
}

console.log('test-clark-radar-whale-toolcalls.mjs: all assertions passed')
