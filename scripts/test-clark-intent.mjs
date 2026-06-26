import assert from 'node:assert/strict'
import {
  classifyClarkPrompt,
  extractRequestedChainFromPrompt,
  formatEoaLpCheckReply,
  formatBaseMarketReadFromRows,
  formatBaseRadarRead,
  formatTokenScanResult,
  formatTokenSafetyAnswer,
  formatDevRugCheck,
  formatLpLockCheck,
  formatRiskExplanation,
  formatNoTokenInMemory,
  isWalletFollowupPrompt,
  classifyWalletFollowupKind,
} from '../lib/server/clarkRouting.ts'

// ─── base_market_discovery vs base_radar ─────────────────────────────────────
assert.equal(classifyClarkPrompt("who's pumping on Base?").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt("whos pumping on base").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt("what Base pairs are pumping?").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt("show me trending Base tokens").intent, 'base_market_discovery')
assert.equal(classifyClarkPrompt("what's pumping on Base Radar?").intent, 'base_radar')

// ─── Token-over-wallet routing priority ───────────────────────────────────────
// "scan this token 0x..." must never route to wallet_scan
{
  const r = classifyClarkPrompt('scan this token 0xabcdef1234567890abcdef1234567890abcdef12 on base')
  assert.equal(r.intent, 'token_scan', 'scan this token ... on base => token_scan, not wallet_scan')
  assert.equal(r.address, '0xabcdef1234567890abcdef1234567890abcdef12')
}
{
  const r = classifyClarkPrompt('token scan 0xabcdef1234567890abcdef1234567890abcdef12')
  assert.equal(r.intent, 'token_scan', 'token scan 0x => token_scan')
}
{
  const r = classifyClarkPrompt('is this token safe 0xabcdef1234567890abcdef1234567890abcdef12')
  assert.ok(r.intent === 'token_safety' || r.intent === 'token_scan', 'is this token safe => token_safety or token_scan, not wallet_scan')
}
{
  const r = classifyClarkPrompt('scan this wallet 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan', 'explicit wallet keyword => wallet_scan')
}
{
  const r = classifyClarkPrompt('wallet pnl 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan', 'wallet pnl => wallet_scan')
}
{
  // bare address: hasOtherStrongIntent is false, so wallet_scan is the fallback
  const r = classifyClarkPrompt('0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan', 'bare address => wallet_scan fallback')
}
{
  // address + "on base" signals token, not wallet
  const r = classifyClarkPrompt('0xabcdef1234567890abcdef1234567890abcdef12 on base')
  assert.notEqual(r.intent, 'wallet_scan', 'address + on base must not be wallet_scan')
}

// ─── wallet_scan ──────────────────────────────────────────────────────────────
{
  const r = classifyClarkPrompt('scan this wallet 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan')
  assert.equal(r.deep, false)
  assert.ok(Array.isArray(r.addresses) && r.addresses.length === 1, 'addresses array populated')
}
{
  const r = classifyClarkPrompt('deep scan this wallet 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan')
  assert.equal(r.deep, true)
}
{
  const r = classifyClarkPrompt('analyze wallet 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan')
  assert.equal(r.deep, true)
}
{
  const r = classifyClarkPrompt('wallet pnl 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan')
  assert.equal(r.deep, true)
}
{
  const r = classifyClarkPrompt('0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'wallet_scan')
}

// ─── wallet compare ───────────────────────────────────────────────────────────
{
  const r = classifyClarkPrompt('compare this wallet with 0x79abcdefabcdefabcdefabcdefabcdefabcdef12')
  assert.equal(r.intent, 'wallet_compare')
  assert.ok(r.addresses.length >= 1, 'compare captures typed address')
}

// ─── wallet PnL follow-up ─────────────────────────────────────────────────────
{
  const r = classifyClarkPrompt('why is pnl missing')
  assert.equal(r.intent, 'wallet_pnl_followup')
  assert.equal(r.deep, false)
}
{
  const r = classifyClarkPrompt('dig deeper into this wallet')
  assert.equal(r.intent, 'wallet_pnl_followup')
  assert.equal(r.deep, false)
}
{
  assert.equal(isWalletFollowupPrompt('is this wallet profitable'), true)
  assert.equal(classifyWalletFollowupKind('is this wallet profitable'), 'wallet_profitability')
  assert.equal(classifyWalletFollowupKind('top holdings'), 'wallet_holdings')
  assert.equal(classifyWalletFollowupKind('what chains is it active on'), 'wallet_chains')
  assert.equal(classifyWalletFollowupKind('should I deep scan'), 'wallet_deep_scan_advice')
  assert.equal(isWalletFollowupPrompt('scan this token on base'), false)
}

// ─── liquidity_scan ───────────────────────────────────────────────────────────
{
  const r = classifyClarkPrompt('lp check 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.address, '0x1234567890123456789012345678901234567890')
}

// ─── Pack 1: token_scan ───────────────────────────────────────────────────────
{
  const r = classifyClarkPrompt('scan this token 0xabcdef1234567890abcdef1234567890abcdef12')
  assert.equal(r.intent, 'token_scan')
  assert.equal(r.address, '0xabcdef1234567890abcdef1234567890abcdef12')
}
{
  const r = classifyClarkPrompt('token scan 0xabcdef1234567890abcdef1234567890abcdef12')
  assert.equal(r.intent, 'token_scan')
}
{
  // symbol-only scan
  const r = classifyClarkPrompt('token scan VIRTUAL')
  assert.equal(r.intent, 'token_scan')
  assert.equal(r.symbol, 'VIRTUAL')
}

// ─── Pack 1: token_safety ─────────────────────────────────────────────────────
{
  assert.equal(classifyClarkPrompt('is this token safe').intent, 'token_safety')
  assert.equal(classifyClarkPrompt('is this a rug').intent, 'token_safety')
  assert.equal(classifyClarkPrompt('should I buy this token').intent, 'token_safety')
  assert.equal(classifyClarkPrompt('is it risky').intent, 'token_safety')
}

// ─── Pack 1: dev_rug_check ────────────────────────────────────────────────────
{
  assert.equal(classifyClarkPrompt('can the dev rug this').intent, 'dev_rug_check')
  assert.equal(classifyClarkPrompt('is ownership renounced').intent, 'dev_rug_check')
  assert.equal(classifyClarkPrompt('can they mint').intent, 'dev_rug_check')
  assert.equal(classifyClarkPrompt('dev wallet risk').intent, 'dev_rug_check')
}

// ─── Pack 1: lp_lock_check ────────────────────────────────────────────────────
{
  assert.equal(classifyClarkPrompt('is LP locked').intent, 'lp_lock_check')
  assert.equal(classifyClarkPrompt('can liquidity be pulled').intent, 'lp_lock_check')
  assert.equal(classifyClarkPrompt('explain LP').intent, 'lp_lock_check')
  assert.equal(classifyClarkPrompt('is liquidity safe').intent, 'lp_lock_check')
}

// ─── Pack 1: risk_explanation ─────────────────────────────────────────────────
{
  assert.equal(classifyClarkPrompt('why is this high risk').intent, 'risk_explanation')
  assert.equal(classifyClarkPrompt('explain the risk').intent, 'risk_explanation')
  assert.equal(classifyClarkPrompt('what are the red flags').intent, 'risk_explanation')
  assert.equal(classifyClarkPrompt('why caution').intent, 'risk_explanation')
}

// ─── formatting helpers ───────────────────────────────────────────────────────
assert.equal(formatBaseMarketReadFromRows([]), null)
assert.equal(formatBaseMarketReadFromRows(null), null)
assert.equal(formatBaseRadarRead([]), null)
assert.equal(formatBaseRadarRead(null), null)

const eoaReply = formatEoaLpCheckReply()
assert.ok(eoaReply.includes('wallet, not a token contract'))
assert.ok(eoaReply.includes('CTA:'))

// ─── Pack 1: format functions output shape ────────────────────────────────────
const mockEv = {
  token: { name: 'Brett', symbol: 'BRETT', address: '0xabcdef1234567890abcdef1234567890abcdef12' },
  chain: 'Base',
  market: { price: 0.08, change24h: 12.4, volume24h: 5_000_000, liquidity: 2_000_000, marketCap: 400_000_000 },
  holders: { top1: 8.2, top10: 42.1, holderCount: 12000 },
  security: { honeypot: false, buyTax: 0, sellTax: 0, ownerRenounced: true, mintable: false, proxy: false, securityStatus: 'clean', riskLevel: 'low', missing: [] },
  lpControl: { status: 'locked', reason: 'locked via protocol', confidence: 'high', poolType: 'v2' },
  warnings: [],
  ok: true,
}

{
  const out = formatTokenScanResult(mockEv)
  assert.ok(out.startsWith('TOKEN READ'))
  assert.ok(out.includes('BRETT'))
  assert.ok(out.includes('LP proof'))
  assert.ok(out.includes('Verdict:'))
  assert.ok(out.includes('CTA:'))
  // no fake certainty
  assert.ok(!out.toLowerCase().includes('confirmed safe'))
  assert.ok(!out.toLowerCase().includes('confirmed pump'))
}

{
  const out = formatTokenSafetyAnswer(mockEv)
  assert.ok(out.startsWith('TOKEN SAFETY'))
  assert.ok(out.includes('Verdict:'))
  assert.ok(out.includes('CTA:'))
  assert.ok(!out.toLowerCase().includes('this token is safe'))
}

{
  const out = formatDevRugCheck(mockEv)
  assert.ok(out.startsWith('DEV/RUG CHECK'))
  assert.ok(out.includes('Ownership:'))
  assert.ok(out.includes('Mint authority:'))
  assert.ok(out.includes('LP control:'))
}

{
  const out = formatLpLockCheck(mockEv)
  assert.ok(out.startsWith('LP CHECK'))
  assert.ok(out.includes('Status:'))
  // leads with lock/burn/control status, not just liquidity depth number
  assert.ok(out.includes('lock/burn proof confirmed') || out.includes('controlled') || out.includes('not confirmed') || out.includes('concentrated'))
}

{
  const out = formatRiskExplanation(mockEv)
  assert.ok(out.startsWith('RISK EXPLANATION'))
  assert.ok(out.includes('CTA:'))
  // does not invent score
  assert.ok(!out.includes('score formula'))
}

{
  const out = formatNoTokenInMemory()
  assert.ok(out.includes('contract address'))
  assert.ok(out.includes('CTA:'))
}

// ─── Task D: chain override parsing for token scans ───────────────────────────
{
  const r = classifyClarkPrompt('scan this eth token 0xabcdef1234567890abcdef1234567890abcdef12')
  assert.equal(r.intent, 'token_scan', 'scan this eth token 0x... => token_scan')
  assert.equal(r.address, '0xabcdef1234567890abcdef1234567890abcdef12')
}
{
  const r = classifyClarkPrompt('0xabcdef1234567890abcdef1234567890abcdef12 scan this eth token')
  assert.equal(r.intent, 'token_scan', 'address before "scan this eth token" => token_scan')
}
{
  const r = classifyClarkPrompt('scan 0xabcdef1234567890abcdef1234567890abcdef12 on ethereum')
  assert.equal(r.intent, 'token_scan', 'scan 0x... on ethereum => token_scan')
}
{
  const r = classifyClarkPrompt('scan this bnb token 0xabcdef1234567890abcdef1234567890abcdef12')
  assert.equal(r.intent, 'token_scan', 'scan this bnb token 0x... => token_scan')
}
{
  const r = classifyClarkPrompt('0xabcdef1234567890abcdef1234567890abcdef12 scan this bsc token')
  assert.equal(r.intent, 'token_scan', 'address before "scan this bsc token" => token_scan')
}
{
  const r = classifyClarkPrompt('scan this base token 0xabcdef1234567890abcdef1234567890abcdef12')
  assert.equal(r.intent, 'token_scan', 'scan this base token 0x... => token_scan')
}
{
  // existing behavior preserved: no chain named, no "on base" — still token_scan
  const r = classifyClarkPrompt('scan this token 0xabcdef1234567890abcdef1234567890abcdef12')
  assert.equal(r.intent, 'token_scan')
}

assert.equal(extractRequestedChainFromPrompt('scan this eth token 0xabc'), 'ethereum')
assert.equal(extractRequestedChainFromPrompt('scan this ethereum token'), 'ethereum')
assert.equal(extractRequestedChainFromPrompt('scan on eth'), 'ethereum')
assert.equal(extractRequestedChainFromPrompt('scan on ethereum'), 'ethereum')
assert.equal(extractRequestedChainFromPrompt('eth token 0xabc'), 'ethereum')
assert.equal(extractRequestedChainFromPrompt('ethereum 0xabc'), 'ethereum')
assert.equal(extractRequestedChainFromPrompt('bnb token 0xabc'), 'bnb')
assert.equal(extractRequestedChainFromPrompt('bsc token 0xabc'), 'bnb')
assert.equal(extractRequestedChainFromPrompt('base token 0xabc'), 'base')
assert.equal(extractRequestedChainFromPrompt('scan this token 0xabc'), null, 'no chain named => null, caller falls back to default')
// Token prompt with explicit ETH must never route as a wallet scan
{
  const r = classifyClarkPrompt('0xabcdef1234567890abcdef1234567890abcdef12 scan this eth token')
  assert.notEqual(r.intent, 'wallet_scan', 'eth token prompt must not route to wallet_scan')
}


{
  const phrases = ['scan brett', 'scan $BRETT', 'token scan BRETT', 'check BRETT']
  for (const phrase of phrases) {
    const r = classifyClarkPrompt(phrase)
    assert.equal(r.intent, 'token_scan', `${phrase} => token_scan`)
    assert.equal(r.symbol, 'BRETT', `${phrase} extracts BRETT`)
  }
}
{
  const phrases = ['liquidity check aero', 'liquidity AERO', 'explain liquidity AERO', 'check LP AERO', 'LP check AERO']
  for (const phrase of phrases) {
    const r = classifyClarkPrompt(phrase)
    assert.equal(r.intent, 'liquidity_scan', `${phrase} => liquidity_scan`)
    assert.equal(r.symbol, 'AERO', `${phrase} extracts AERO`)
  }
}
{
  const r = classifyClarkPrompt('explain liquidity')
  assert.equal(r.intent, 'lp_lock_check', 'explain liquidity uses last token LP context when available')
  assert.equal(r.symbol, null)
}

// ─── Dashboard quick actions (Clark drawer hint chips) ────────────────────────
{
  // "Scan BRETT" — bare named-token scan, no literal "token" keyword
  const r = classifyClarkPrompt('Scan BRETT')
  assert.equal(r.intent, 'token_scan', 'Scan BRETT => token_scan')
  assert.equal(r.symbol, 'BRETT')
  assert.equal(r.address, null)
}
{
  // "Liquidity check AERO" — symbol-only liquidity check, no address
  const r = classifyClarkPrompt('Liquidity check AERO')
  assert.equal(r.intent, 'liquidity_scan', 'Liquidity check AERO => liquidity_scan')
  assert.equal(r.symbol, 'AERO')
  assert.equal(r.address, null)
}
{
  // "Show Base whales" — whale_alert, already worked pre-fix
  const r = classifyClarkPrompt('Show Base whales')
  assert.equal(r.intent, 'whale_alert', 'Show Base whales => whale_alert')
}
{
  // "What's pumping on Base?" — base_market_discovery, already worked pre-fix
  const r = classifyClarkPrompt("What's pumping on Base?")
  assert.equal(r.intent, 'base_market_discovery', "What's pumping on Base? => base_market_discovery")
}
{
  // liquidity_scan with an address still does not carry a redundant symbol
  const r = classifyClarkPrompt('liquidity check 0x1234567890123456789012345678901234567890')
  assert.equal(r.intent, 'liquidity_scan')
  assert.equal(r.address, '0x1234567890123456789012345678901234567890')
  assert.equal(r.symbol, null)
}

console.log('test-clark-intent.mjs: all assertions passed')
