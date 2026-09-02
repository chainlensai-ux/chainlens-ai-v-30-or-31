// Token Scanner trading simulation / honeypot final-status classification.
// Pure classification + cache key + UI copy. No live network.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  TRADING_SIMULATION_SUPPORT,
  ROBINHOOD_SIM_CHAIN_ID,
  ROBINHOOD_SIM_UNSUPPORTED_REASON,
  ROBINHOOD_SIM_UNSUPPORTED_IMPACT,
  ROBINHOOD_SIM_SOURCE,
  ROBINHOOD_SIM_TIMEOUT_LABEL,
  SOLANA_SIM_NOT_APPLICABLE_REASON,
  tradingSimulationSupportFor,
  providerSupportsTradingSimulation,
  buildTradingSimulationCacheKey,
  isTradingSimulationCacheHitValid,
  classifyTradingSimulation,
  classifyFromRobinhoodHoneypotSim,
  buildTradingSimulationUi,
} = await import('../lib/tradingSimulation.ts')

const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const routeSrc = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
const honeypotSrc = readFileSync(new URL('../lib/server/honeypotSecurity.ts', import.meta.url), 'utf8')

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed += 1
}

const TOKEN = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const BASE_TOKEN = '0xcccccccccccccccccccccccccccccccccccccccc'
const POOL = '0xdddddddddddddddddddddddddddddddddddddddd'

// ── 1. Support matrix ───────────────────────────────────────────────────────
{
  const base = tradingSimulationSupportFor('base', 8453)
  const eth = tradingSimulationSupportFor('eth', 1)
  const bnb = tradingSimulationSupportFor('bnb', 56)
  const rh = tradingSimulationSupportFor('robinhood', 4663)
  const sol = tradingSimulationSupportFor('solana', null)
  check('Base support uses chainId 8453', base.chainId === 8453 && base.honeypotIs === true)
  check('ETH support uses chainId 1', eth.chainId === 1 && eth.honeypotIs === true)
  check('BNB support uses chainId 56', bnb.chainId === 56 && bnb.honeypotIs === true)
  check('Robinhood chainId is 4663 only', rh.chainId === ROBINHOOD_SIM_CHAIN_ID && ROBINHOOD_SIM_CHAIN_ID === 4663)
  check('Robinhood has no honeypot.is/GoPlus provider', rh.honeypotIs === false && rh.goplus === false)
  check('Robinhood sim provider is enabled', rh.robinhoodSim === true)
  check('Solana is not applicable', sol.notApplicable === true && sol.honeypotIs === false)
  check('matrix Base/ETH/BNB/Robinhood/Solana keys exist',
    TRADING_SIMULATION_SUPPORT.base.honeypotIs
    && TRADING_SIMULATION_SUPPORT.eth.honeypotIs
    && TRADING_SIMULATION_SUPPORT.bnb.honeypotIs
    && TRADING_SIMULATION_SUPPORT.robinhood.honeypotIs === false
    && TRADING_SIMULATION_SUPPORT.robinhood.robinhoodSim === true
    && TRADING_SIMULATION_SUPPORT.solana.notApplicable === true)
  check('none provider never supports a chain', providerSupportsTradingSimulation(base, 'none') === false)
  check('chainlens_robinhood_sim only on Robinhood', providerSupportsTradingSimulation(rh, 'chainlens_robinhood_sim') === true && providerSupportsTradingSimulation(base, 'chainlens_robinhood_sim') === false)
}

// ── 2. Robinhood no-provider fallback — exact copy, never fake-safe ─────────
{
  const audit = classifyTradingSimulation({
    chainSlug: 'robinhood',
    chainId: 4663,
    tokenAddress: TOKEN,
    providerSelected: 'none',
    requestAttempted: false,
    requestChainId: null,
  })
  const ui = buildTradingSimulationUi(audit)
  check('Robinhood finalStatus is unsupported_on_robinhood', audit.finalStatus === 'unsupported_on_robinhood')
  check('Robinhood requestAttempted is false', audit.requestAttempted === false)
  check('Robinhood is not marked verified_clear', audit.finalStatus !== 'verified_clear')
  check('Robinhood honeypotResult stays null', audit.honeypotResult === null)
  check('Robinhood unsupported UI prefixes reason', ui.statusLabel === `Unsupported: ${ROBINHOOD_SIM_UNSUPPORTED_REASON}`)
  check('Robinhood reason copy is exact', ui.reason === ROBINHOOD_SIM_UNSUPPORTED_REASON)
  check('Robinhood impact copy is exact', ui.impact === ROBINHOOD_SIM_UNSUPPORTED_IMPACT)
  check('Robinhood reason names chainId 4663', ui.reason.includes('4663'))
  check('Robinhood tax rows hidden', ui.showTaxRows === false)
  check('Robinhood honeypot value is not Open Check', !/open check/i.test(ui.honeypotValue))
  check('Robinhood buy tax is not Open Check', !/open check/i.test(ui.buyTaxValue))
  check('Robinhood sell tax is not Open Check', !/open check/i.test(ui.sellTaxValue))
  check('Robinhood UI never says Open Check', !/open check/i.test(`${ui.statusLabel} ${ui.reason} ${ui.badge} ${ui.honeypotValue}`))
}

// ── 3. Timeout is a final status, including before Robinhood unsupported ────
{
  const baseTimeout = classifyTradingSimulation({
    chainSlug: 'base',
    chainId: 8453,
    tokenAddress: TOKEN,
    providerSelected: 'honeypot_is',
    requestAttempted: true,
    timedOut: true,
    honeypotStatus: 'timeout',
    honeypotReason: 'Security simulation timed out',
  })
  check('Base timeout is provider_timeout', baseTimeout.finalStatus === 'provider_timeout')
  const timeoutUi = buildTradingSimulationUi(baseTimeout)
  check('timeout UI label is Timed out', timeoutUi.statusLabel === 'Timed out')
  check('timeout UI is not Open Check', !/open check/i.test(`${timeoutUi.statusLabel} ${timeoutUi.honeypotValue}`))
  check('timeout treats as open risk, not safe', timeoutUi.treatAsOpenRisk === true && baseTimeout.finalStatus !== 'verified_clear')

  const rhTimeout = classifyTradingSimulation({
    chainSlug: 'robinhood',
    chainId: 4663,
    tokenAddress: TOKEN,
    timedOut: true,
    honeypotStatus: 'timeout',
  })
  check('timeout classifies before Robinhood unsupported', rhTimeout.finalStatus === 'provider_timeout')
  const rhTimeoutUi = buildTradingSimulationUi(rhTimeout)
  check('Robinhood timeout UI is Simulation timed out', rhTimeoutUi.statusLabel === ROBINHOOD_SIM_TIMEOUT_LABEL)
  check('Robinhood timeout is not a honeypot', rhTimeout.honeypotResult !== true && rhTimeout.finalStatus !== 'risk_detected')
}

// ── 4. Base/ETH cache is rejected for Robinhood ─────────────────────────────
{
  const baseKey = buildTradingSimulationCacheKey(8453, TOKEN, 'honeypot_is')
  const rhKey = buildTradingSimulationCacheKey(4663, TOKEN, 'honeypot_is')
  const ethKey = buildTradingSimulationCacheKey(1, TOKEN, 'honeypot_is')
  const rhSimKey = buildTradingSimulationCacheKey(4663, TOKEN, 'chainlens_robinhood_sim', POOL)
  const rhSimOtherPool = buildTradingSimulationCacheKey(4663, TOKEN, 'chainlens_robinhood_sim', BASE_TOKEN)
  check('cache key includes chainId', baseKey.includes('8453') && rhKey.includes('4663'))
  check('cache key includes provider', baseKey.startsWith('sim:honeypot_is:'))
  check('cache key includes token', baseKey.endsWith(TOKEN))
  check('Base and Robinhood cache keys differ', baseKey !== rhKey)
  check('ETH and Robinhood cache keys differ', ethKey !== rhKey)
  check('Robinhood sim cache key includes pool', rhSimKey.includes(POOL))
  check('Robinhood sim cache keys differ by pool', rhSimKey !== rhSimOtherPool)
  check('Base cache rejected for Robinhood selected', isTradingSimulationCacheHitValid(
    { chainId: 8453, tokenAddress: TOKEN, provider: 'honeypot_is' },
    { chainId: 4663, tokenAddress: TOKEN, provider: 'honeypot_is' },
  ) === false)
  check('ETH cache rejected for Robinhood selected', isTradingSimulationCacheHitValid(
    { chainId: 1, tokenAddress: TOKEN, provider: 'honeypot_is' },
    { chainId: 4663, tokenAddress: TOKEN, provider: 'honeypot_is' },
  ) === false)
  check('matching Base cache is valid', isTradingSimulationCacheHitValid(
    { chainId: 8453, tokenAddress: TOKEN, provider: 'honeypot_is' },
    { chainId: 8453, tokenAddress: TOKEN, provider: 'honeypot_is' },
  ) === true)
  check('token mismatch is rejected', isTradingSimulationCacheHitValid(
    { chainId: 8453, tokenAddress: TOKEN, provider: 'honeypot_is' },
    { chainId: 8453, tokenAddress: BASE_TOKEN, provider: 'honeypot_is' },
  ) === false)
  check('Robinhood sim wrong chain cache rejected', isTradingSimulationCacheHitValid(
    { chainId: 8453, tokenAddress: TOKEN, provider: 'chainlens_robinhood_sim', poolAddress: POOL },
    { chainId: 4663, tokenAddress: TOKEN, provider: 'chainlens_robinhood_sim', poolAddress: POOL },
  ) === false)
  check('Robinhood sim pool mismatch rejected', isTradingSimulationCacheHitValid(
    { chainId: 4663, tokenAddress: TOKEN, provider: 'chainlens_robinhood_sim', poolAddress: POOL },
    { chainId: 4663, tokenAddress: TOKEN, provider: 'chainlens_robinhood_sim', poolAddress: BASE_TOKEN },
  ) === false)
}

// ── 5. Base/BNB verified sims still render taxes ────────────────────────────
{
  const base = classifyTradingSimulation({
    chainSlug: 'base',
    chainId: 8453,
    tokenAddress: TOKEN,
    providerSelected: 'honeypot_is',
    requestAttempted: true,
    requestChainId: 8453,
    honeypotResult: false,
    buyTax: 1.5,
    sellTax: 2,
    simulationSuccess: true,
    honeypotStatus: 'confirmed',
  })
  const baseUi = buildTradingSimulationUi(base)
  check('Base verified_clear', base.finalStatus === 'verified_clear')
  check('Base shows tax rows', baseUi.showTaxRows === true)
  check('Base buy tax renders', baseUi.buyTaxValue === '1.5%')
  check('Base sell tax renders', baseUi.sellTaxValue === '2.0%')
  check('Base honeypot is NO', baseUi.honeypotValue === 'NO')
  check('Base status is Verified clear', baseUi.statusLabel === 'Verified clear')

  const bnb = classifyTradingSimulation({
    chainSlug: 'bnb',
    chainId: 56,
    tokenAddress: TOKEN,
    providerSelected: 'honeypot_is',
    requestAttempted: true,
    honeypotResult: false,
    buyTax: 0,
    sellTax: 0,
    simulationSuccess: true,
    honeypotStatus: 'confirmed',
  })
  const bnbUi = buildTradingSimulationUi(bnb)
  check('BNB verified_clear', bnb.finalStatus === 'verified_clear')
  check('BNB taxes still render', bnbUi.showTaxRows === true && bnbUi.buyTaxValue === '0.0%' && bnbUi.sellTaxValue === '0.0%')

  const risky = classifyTradingSimulation({
    chainSlug: 'eth',
    chainId: 1,
    tokenAddress: TOKEN,
    providerSelected: 'honeypot_is',
    requestAttempted: true,
    honeypotResult: true,
    buyTax: 12,
    sellTax: 20,
    simulationSuccess: true,
    honeypotStatus: 'confirmed',
  })
  const riskyUi = buildTradingSimulationUi(risky)
  check('ETH honeypot is risk_detected', risky.finalStatus === 'risk_detected')
  check('ETH risk still shows taxes', riskyUi.showTaxRows === true && riskyUi.sellTaxValue === '20.0%')
  check('ETH risk is not marked verified_clear', risky.finalStatus !== 'verified_clear')
}

// ── 6. Solana is not applicable — no EVM honeypot wording ───────────────────
{
  const sol = classifyTradingSimulation({
    chainSlug: 'solana',
    chainId: null,
    tokenAddress: 'So11111111111111111111111111111111111111112',
  })
  const ui = buildTradingSimulationUi(sol)
  check('Solana finalStatus is not_applicable', sol.finalStatus === 'not_applicable')
  check('Solana reason is native-only', sol.finalReason === SOLANA_SIM_NOT_APPLICABLE_REASON)
  check('Solana UI is Not applicable', ui.statusLabel === 'Not applicable')
  check('Solana copy does not say honeypot YES/NO', !/\bYES\b|\bNO\b/.test(ui.honeypotValue))
  check('Solana copy mentions Solana-native, not EVM honeypot result', /solana-native/i.test(ui.reason) && !/sell-block simulation verified/i.test(ui.reason))
  check('Solana is not Open Check', !/open check/i.test(`${ui.statusLabel} ${ui.reason} ${ui.honeypotValue}`))
}

// ── 7. No final Open Check in Trading Simulation card; Risk Engine + sidebar share helper ──
{
  const cardStart = pageSrc.indexOf('{/* Trading Simulation */}')
  check('Trading Simulation card exists', cardStart >= 0)
  const cardEnd = pageSrc.indexOf('{/* Contract Flags */}', cardStart)
  const card = pageSrc.slice(cardStart, cardEnd)
  check('Trading Simulation card uses simAuditUi helper', /simAuditUi\.(badge|statusLabel|reason)/.test(card))
  check('Trading Simulation card has no Open Check fallback', !/Open check/i.test(card))
  check('Trading Simulation card shows Source row', /simAuditUi\.source/.test(card))
  check('page helper tradingSimUiFor is shared', pageSrc.includes('function tradingSimUiFor(result: ScanResult)'))
  check('Risk Engine uses tradingSimUiFor', /const simAuditUi = tradingSimUiFor\(result\)/.test(pageSrc))
  check('sidebar uses tradingSimUiFor', /const simUi = tradingSimUiFor\(result\)/.test(pageSrc))
  check('sidebar renders simUi.statusLabel', /<p style=\{stitle\}>Trading Simulation<\/p>[\s\S]{0,220}\{simUi\.statusLabel\}/.test(pageSrc))
  check('sidebar renders same honeypot/tax/source rows', /simUi\.honeypotValue/.test(pageSrc) && /simUi\.buyTaxValue/.test(pageSrc) && /simUi\.source/.test(pageSrc))
  check('verdict chips use simUi not Open check', /simUi\.honeypotValue/.test(pageSrc))
  check('holders security value uses helper status', /const securityValue = simUiHolders\.statusLabel/.test(pageSrc))
  check('Security Confidence uses helper status', /const securityConfidenceLabel = simUiOverview\.statusLabel/.test(pageSrc))
}

// ── 8. Backend: Robinhood skips honeypot.is, runs ChainLens sim after pool ──
{
  check('route skips fetchHoneypotSecurity for Robinhood', /chain === 'robinhood'[\s\S]{0,180}ROBINHOOD_SIM_CHAIN_ID/.test(routeSrc))
  check('GoPlus fallback skipped for Robinhood', /chain !== 'robinhood'/.test(routeSrc))
  check('route attaches tradingSimulationAudit', /tradingSimulationAudit = await resolveTradingSimulationAudit/.test(routeSrc) || /let tradingSimulationAudit = await resolveTradingSimulationAudit/.test(routeSrc))
  check('payload includes tradingSimulationAudit', /\(responsePayload as any\)\.tradingSimulationAudit = tradingSimulationAudit/.test(routeSrc))
  check('payload includes robinhoodTradingSimulationAudit', /robinhoodTradingSimulationAudit/.test(routeSrc))
  check('honeypot payload carries finalStatus', /finalStatus:\s+tradingSimulationAudit\.finalStatus/.test(routeSrc))
  check('security.simulationStatus uses finalStatus, not open_check', /simulationStatus: tradingSimulationAudit\.finalStatus/.test(routeSrc))
  check('clusterMap simulationStatus is not hardcoded open_check', !/simulationStatus: hpResult\.ok \? 'ok' : 'open_check'/.test(routeSrc))
  check('fetchHoneypotSecurity does not default missing chainId to base', !/chainIdOrNetwork: string \| number = "base"/.test(honeypotSrc))
  check('missing chainId returns an explicit unavailable reason', /Trading simulation chain id was not provided/.test(honeypotSrc))
  const poolIdx = routeSrc.indexOf('const lpPoolAddress = lpPool?.address ?? null')
  const simIdx = routeSrc.indexOf('simulateRobinhoodHoneypot(')
  check('simulateRobinhoodHoneypot is called', simIdx >= 0)
  check('simulateRobinhoodHoneypot runs after selected pool', poolIdx >= 0 && simIdx > poolIdx)
  check('Robinhood sim is gated to robinhood chain', /if \(chain === 'robinhood'\) \{\s*const \{ result: rhSim/.test(routeSrc) || /if \(chain === 'robinhood'\) \{[\s\S]{0,200}simulateRobinhoodHoneypot/.test(routeSrc))
  check('sellable does not set hpResult.ok true', /hpResult\.ok = false/.test(routeSrc))
  check('route never marks Robinhood sim as honeypot.is ok', !/hpResult\.ok = true/.test(routeSrc))
}

// ── 9. Robinhood sim classify + UI ──────────────────────────────────────────
{
  const sellable = classifyFromRobinhoodHoneypotSim({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    attempted: true,
    sellable: true,
    honeypotStatus: 'sellable',
    buyTaxPct: 1.2,
    sellTaxPct: 2.4,
    failureReason: null,
    rawProviderError: null,
  })
  const sellableUi = buildTradingSimulationUi(sellable)
  check('sellable finalStatus is simulated, never verified_clear', sellable.finalStatus === 'simulated' && sellable.finalStatus !== 'verified_clear')
  check('sellable treats as open risk', sellableUi.treatAsOpenRisk === true)
  check('sellable honeypot value is Sellable', sellableUi.honeypotValue === 'Sellable')
  check('sellable status is Sellable', sellableUi.statusLabel === 'Sellable')
  check('sellable shows taxes', sellableUi.showTaxRows === true && sellableUi.buyTaxValue === '1.2%' && sellableUi.sellTaxValue === '2.4%')
  check('sellable source is ChainLens Robinhood simulation', sellableUi.source === ROBINHOOD_SIM_SOURCE)
  check('sellable audit cache key includes chain+token+pool', sellable.cacheKey.includes('4663') && sellable.cacheKey.includes(TOKEN) && sellable.cacheKey.includes(POOL))
  check('sellable is not Open Check', !/open check/i.test(`${sellableUi.statusLabel} ${sellableUi.honeypotValue}`))

  const blocked = classifyFromRobinhoodHoneypotSim({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    attempted: true,
    sellable: false,
    honeypotStatus: 'blocked',
    buyTaxPct: null,
    sellTaxPct: null,
    failureReason: 'Simulated sell failed',
    rawProviderError: null,
  })
  const blockedUi = buildTradingSimulationUi(blocked)
  check('blocked finalStatus is risk_detected', blocked.finalStatus === 'risk_detected')
  check('blocked honeypot value is Blocked', blockedUi.honeypotValue === 'Blocked')
  check('blocked status is Blocked', blockedUi.statusLabel === 'Blocked')
  check('blocked source is ChainLens Robinhood simulation', blockedUi.source === ROBINHOOD_SIM_SOURCE)
  check('blocked is not Open Check', !/open check/i.test(`${blockedUi.statusLabel} ${blockedUi.honeypotValue}`))

  const missingPool = classifyFromRobinhoodHoneypotSim({
    tokenAddress: TOKEN,
    poolAddress: null,
    attempted: false,
    sellable: null,
    honeypotStatus: 'unsupported',
    buyTaxPct: null,
    sellTaxPct: null,
    failureReason: 'No selected Robinhood pool',
    rawProviderError: null,
  })
  const missingUi = buildTradingSimulationUi(missingPool)
  check('missing pool is unsupported', missingPool.finalStatus === 'unsupported_on_robinhood')
  check('missing pool UI is Unsupported: reason', missingUi.statusLabel === 'Unsupported: No selected Robinhood pool')

  const timedOut = classifyFromRobinhoodHoneypotSim({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    attempted: true,
    sellable: null,
    honeypotStatus: 'timeout',
    buyTaxPct: null,
    sellTaxPct: null,
    failureReason: 'Simulation timed out',
    rawProviderError: 'timeout',
  })
  const timedUi = buildTradingSimulationUi(timedOut)
  check('RPC timeout is provider_timeout not honeypot', timedOut.finalStatus === 'provider_timeout' && timedOut.finalStatus !== 'risk_detected')
  check('timeout UI is Simulation timed out', timedUi.statusLabel === ROBINHOOD_SIM_TIMEOUT_LABEL)

  const unavailable = classifyFromRobinhoodHoneypotSim({
    tokenAddress: TOKEN,
    poolAddress: POOL,
    attempted: true,
    sellable: null,
    honeypotStatus: 'unavailable',
    buyTaxPct: null,
    sellTaxPct: null,
    failureReason: 'Robinhood RPC is not configured',
    rawProviderError: null,
  })
  const unUi = buildTradingSimulationUi(unavailable)
  check('RPC failure is unavailable not honeypot', unavailable.finalStatus === 'unavailable_with_reason')
  check('unavailable UI prefixes exact reason', unUi.statusLabel === 'Unavailable: Robinhood RPC is not configured')
}

console.log(`test-trading-simulation: ${passed} checks passed`)
