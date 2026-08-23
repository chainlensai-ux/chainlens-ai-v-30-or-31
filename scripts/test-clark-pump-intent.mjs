// Clark pump-analysis + spec routing regression tests.
// Covers: pump intent routing, whale/accumulation routing, educational guards,
// and the deterministic PUMP READ formatter (data-first, no fabrication).
import assert from 'node:assert/strict'
import {
  classifyClarkPrompt,
  isPumpAnalysisPrompt,
  formatPumpAnalysisRead,
} from '../lib/server/clarkRouting.ts'

const tokenAddr = '0x' + 'a'.repeat(40)

// ── 1. Pump questions route to pump_analysis ──────────────────────────────
{
  const cases = [
    'Why is this token pumping?',
    'Is the pump likely to continue?',
    'Will the pump continue?',
    'Show buy/sell pressure for the pumping token',
    'What could kill this pump?',
    'Is this pump organic or fake?',
    'Show whale buys on the pump',
    'Top sellers on this pump',
    'Volume acceleration check',
  ]
  for (const q of cases) {
    assert.equal(classifyClarkPrompt(q).intent, 'pump_analysis', `expected pump_analysis for: ${q}`)
    assert.ok(isPumpAnalysisPrompt(q), `isPumpAnalysisPrompt false for: ${q}`)
  }
}

// ── 2. Pump analysis with an address keeps the address ───────────────────
{
  const r = classifyClarkPrompt(`Why is this token pumping? ${tokenAddr}`)
  assert.equal(r.intent, 'pump_analysis')
  assert.equal(r.address, tokenAddr)
}

// ── 3. Discovery vs analysis separation ───────────────────────────────────
// "what's pumping on Base" is a DISCOVERY list (base_market_discovery), never pump_analysis.
assert.equal(classifyClarkPrompt("What's pumping on Base?").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt('Show me new Base tokens').intent, 'base_market_discovery')

// ── 4. Plain whale prompts still route to whale_alert, not pump_analysis ──
{
  const cases = ['Show latest whale alerts', 'What did whales buy?', 'Which wallets are accumulating?', 'Any accumulation on Base?']
  for (const q of cases) {
    assert.equal(classifyClarkPrompt(q).intent, 'whale_alert', `expected whale_alert for: ${q}`)
  }
}

// ── 5. Wallet/token routing not broken by the new intent ─────────────────
{
  const walletAddr = '0x' + 'b'.repeat(40)
  assert.equal(classifyClarkPrompt(`Analyze this wallet: ${walletAddr}`).intent, 'wallet_scan')
  assert.equal(classifyClarkPrompt(`Scan this token: ${tokenAddr}`).intent, 'token_scan')
  assert.equal(classifyClarkPrompt(`Is this token safe to ape? ${tokenAddr}`).intent, 'token_ape_risk')
}

// ── 6. Educational questions must NOT become bogus token scans ────────────
{
  // These extract bogus symbols (CORTEX/HOLDER/RANK) but are definition questions.
  for (const q of ['What is CORTEX confidence?', 'What is holder concentration?', 'Why is rank 1 trending?']) {
    assert.notEqual(classifyClarkPrompt(q).intent, 'token_scan', `educational question became token_scan: ${q}`)
  }
  // "What does partial PnL mean?" is a definition, not a session PnL follow-up.
  assert.notEqual(classifyClarkPrompt('What does partial PnL mean?').intent, 'wallet_pnl_followup')
  // But real follow-ups still work.
  assert.equal(classifyClarkPrompt('Why is PnL partial?').intent, 'wallet_pnl_followup')
  assert.equal(classifyClarkPrompt('dig deeper').intent, 'wallet_pnl_followup')
}

// ── 7. formatPumpAnalysisRead: data-first, explicit gaps, no fabrication ──
{
  const report = {
    symbol: 'TEST',
    executiveSummary: {
      momentumScore: 72,
      momentumConfidence: 'medium',
      continuationProbability: 'medium',
      pullbackRisk: 'high',
      overallConfidence: 'medium',
      verdict: 'Momentum-backed move; watch LP depth.',
    },
    marketStructure: {
      buys24h: 812,
      sells24h: 401,
      buySellRatio: 2.02,
      liquidityUsd: 185_000,
      volume24hUsd: 1_240_000,
      holderCount: 1204,
      fdvUsd: 5_600_000,
      ageHours: 14.2,
      top1HolderPercent: 4.1,
    },
    walletIntelligence: {
      largestBuyers: [{ address: '0xabc1234567890abcdef1234567890abcdef123456', side: 'buy', amountUsd: 42_000, isTracked: true }],
      largestSellers: [],
      netWhaleFlowUsd: 31_500,
    },
    evidenceGaps: ['Holder distribution unavailable (Helius key missing)'],
    watchlist: [{ label: 'LP depth', threshold: 'alert if liquidity < $100k' }],
  }
  const read = formatPumpAnalysisRead(report)
  assert.ok(read.includes('PUMP INTELLIGENCE READ — TEST'))
  assert.ok(read.includes('Momentum Score: 72/100'))
  assert.ok(read.includes('Continuation Probability: medium'))
  assert.ok(read.includes('Pullback Risk: high'))
  assert.ok(read.includes('$185.0K') || read.includes('$185K'), 'liquidity formatted')
  assert.ok(read.includes('2.02'), 'buy/sell ratio shown')
  assert.ok(read.includes('Top buyers'))
  assert.ok(!read.includes('Top sellers'), 'empty seller list must not fabricate rows')
  assert.ok(read.includes('Missing data: Holder distribution unavailable'))
  assert.ok(read.includes('LP depth'))

  // Null-safety: missing sections render as n/a / unavailable, never throw.
  const sparse = formatPumpAnalysisRead({ symbol: 'X', executiveSummary: null, marketStructure: null })
  assert.ok(sparse.includes('n/a') && sparse.includes('unavailable'))

  // Null report → null (caller falls back to honest empty state).
  assert.equal(formatPumpAnalysisRead(null), null)
}

console.log('test-clark-pump-intent.mjs: all assertions passed')
