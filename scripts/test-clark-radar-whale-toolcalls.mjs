import assert from 'node:assert/strict'
import {
  classifyClarkToolIntent,
  isClarkWatchlistAddCommand,
} from '../lib/server/clarkRouting.ts'
import { classifyClarkBasicIntent, clarkMissingInputPrompt } from '../lib/server/clarkBasicIntent.ts'

// ─── Base Radar tool intent routing ───────────────────────────────────────
assert.equal(classifyClarkToolIntent("What's pumping on Base?").intent, 'base_radar_movers')
assert.equal(classifyClarkToolIntent('Show me Base movers').intent, 'base_radar_movers')
assert.equal(classifyClarkToolIntent('Find new Base tokens').intent, 'base_radar_movers')
assert.equal(classifyClarkToolIntent("What's trending on Base?").intent, 'base_radar_movers')
assert.equal(classifyClarkToolIntent('Find tokens with high volume/liquidity').intent, 'base_radar_movers')
assert.equal(classifyClarkToolIntent('What are the best radar candidates?').intent, 'base_radar_movers')
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

// ─── Never routes to generic chat (none) for these explicit phrasings ─────
for (const p of [
  "What's pumping on Base?", 'Show me Base movers', 'Find new Base tokens', 'Any low caps on Base?',
  "What's trending on Base?", 'Show Robinhood Chain movers', 'Find tokens with high volume/liquidity',
  'What are the best radar candidates?', 'Any whale alerts?', 'Sync whale alerts', 'Show whale movement',
  'What wallets moved recently?', 'Any big buys/sells?', 'Refresh whale alerts', 'What happened in whale alerts today?',
]) {
  assert.notEqual(classifyClarkToolIntent(p).intent, 'none', `"${p}" must not fall through to generic chat`)
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
