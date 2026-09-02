// Robinhood verified-PnL source audit: prove the Wallet Scanner's "Robinhood: verified" label
// can only come from the Phase 3 sidecar (scanRobinhoodWallet → decode → both-leg prices → FIFO),
// never from V2 pnlV2, holdings delta, transfers, or Blockscout-only activity.
//
// Hard rules encoded here: do not fake PnL, do not loosen decoder/FIFO gates, do not merge
// Base/ETH V2 numbers into the Robinhood lane.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  buildRobinhoodPnlVerificationAudit,
  robinhoodPnlVerificationAuditProvesVerified,
  resolveRobinhoodWalletPnl,
  ROBINHOOD_PNL_PHASE3_SOURCE,
  ROBINHOOD_PNL_NOT_VERIFIED_REASON,
} from '../lib/server/robinhoodWalletScanner.ts'
import { selectRobinhoodPnlLaneStatus } from '../app/frontend/components/PnlStatusCard.tsx'
import { V4_NATIVE_CURRENCY_ADDRESS } from '../lib/server/robinhoodSwapDecoder.ts'
import { ROBINHOOD_V4_POOL_MANAGER } from '../lib/server/uniswapV4RobinhoodRpc.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

function read(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

const WALLET = '0x1111111111111111111111111111111111111a'
const TOKEN_A = '0x2222222222222222222222222222222222222b'

function verifiedAudit(txHash, tokenIn, tokenOut, amountIn, amountOut) {
  return {
    wallet: WALLET, chainId: 4663, txHash, logsSeen: 1, swapLogsSeen: 1,
    routerMatched: null, poolMatched: ROBINHOOD_V4_POOL_MANAGER, decodedSwap: true,
    tokenIn, tokenOut, amountIn, amountOut,
    quoteLeg: 'native_eth', priceEvidence: true, confidence: 'high', rejectedReason: null,
  }
}

function activityWith(overrides = {}) {
  return {
    status: 'ok', wallet: WALLET, chainSlug: 'robinhood', items: [],
    skippedSwapLogs: 0, swapDecodeAudits: [], verifiedSwapCount: 0, reason: null, fromCache: false,
    blockscoutEvidence: {
      blockscoutAttempted: false, blockscoutSucceeded: false, blockscoutFallbackUsed: false,
      blockscoutStatus: 'not_attempted', blockscoutError: null, blockscoutVerifiedSwap: false,
    },
    blockscoutAudits: [], blockscoutSkippedReason: 'GoldRush transactions_v3 already returned usable data — Blockscout fallback was not needed.',
    ...overrides,
  }
}

function holdingsOk() {
  return {
    status: 'ok', wallet: WALLET, chainSlug: 'robinhood', chainId: 4663,
    native: { symbol: 'ETH', rawBalance: '1', uiBalance: 1, priceUsd: 3000, priceSource: 'goldrush', valueUsd: 3000 },
    holdings: [{ address: TOKEN_A, symbol: 'RHT', name: null, decimals: 18, rawBalance: '1', uiBalance: 1, priceUsd: 3, priceSource: 'goldrush', valueUsd: 3 }],
    portfolioTotalUsd: 3003, unpricedTokenCount: 0, reason: null, fromCache: false,
  }
}

function phase3Lane(overrides = {}) {
  const audit = {
    wallet: WALLET, chainId: 4663, source: ROBINHOOD_PNL_PHASE3_SOURCE, status: 'verified',
    realizedPnlUsd: 27542.22, verifiedSwapCount: 12, decodedSwapCount: 12, swapsFedToFifo: 12,
    fifoClosedLots: 10, priceEvidenceBothLegsCount: 12, missingPriceEvidenceCount: 0,
    blockscoutFallbackUsed: false, goldrushUsed: true, alchemyRpcUsed: true,
    pnlEnabledReason: 'ok', pnlDisabledReason: null, rejectedReasonIfNotVerified: null,
    ...overrides,
  }
  return {
    ok: true, wallet: WALLET, chainSlug: 'robinhood', chainId: 4663,
    pnl: {
      status: audit.status,
      message: 'Verified Robinhood PnL',
      realizedPnlUsd: audit.realizedPnlUsd,
      matchedLotsCount: audit.fifoClosedLots,
      verifiedSwapCount: audit.verifiedSwapCount,
      reason: null,
    },
    robinhoodPnlVerificationAudit: audit,
  }
}

async function run() {
  const scannerSrc = read('lib/server/robinhoodWalletScanner.ts')
  const routeSrc = read('app/api/wallet-scan/robinhood/route.ts')
  const workerSrc = read('workers/walletScanV2.ts')
  const pnlCardSrc = read('app/frontend/components/PnlStatusCard.tsx')
  const rhSectionSrc = read('app/frontend/components/RobinhoodChainSection.tsx')
  // SHARED VIEW MODEL, DISCLOSED (Smart Money Score + PnL Evidence UI simplification task): the
  // Robinhood compact-proof gate/fields moved out of a standalone RobinhoodPnlRow component inside
  // PnlStatusCard.tsx into buildWalletPnlViewModel.ts's `robinhoodProof` — the ONE selector both
  // PnlStatusCard.tsx and CORTEX (walletReadBuilder.ts/page.tsx) now read for this exact data, so
  // this file's own checks for "gated on verified", the audit field names, and the proof strings now
  // read from there, not from a JSX literal.
  const viewModelSrc = read('app/frontend/lib/buildWalletPnlViewModel.ts')
  const pageSrc = read('app/terminal/wallet-scanner/page.tsx')
  const holdingsSrc = read('lib/engine/modules/holdings/fetchHoldings.ts')

  // ── 1. Audit shape + source marker ──────────────────────────────────────────────────────────
  {
    const pnl = { status: 'verified', realizedPnlUsd: 27542.22, matchedLotsCount: 10, verifiedSwapCount: 12, reason: null }
    const activity = activityWith({
      swapDecodeAudits: [
        verifiedAudit('0xswap1', V4_NATIVE_CURRENCY_ADDRESS, TOKEN_A, String(1n * 10n ** 18n), String(1000n * 10n ** 18n)),
        verifiedAudit('0xswap2', TOKEN_A, V4_NATIVE_CURRENCY_ADDRESS, String(500n * 10n ** 18n), String(16n * 10n ** 17n)),
      ],
      verifiedSwapCount: 2,
    })
    const audit = buildRobinhoodPnlVerificationAudit({ wallet: WALLET, holdings: holdingsOk(), activity, pnl })
    const required = [
      'wallet', 'chainId', 'source', 'status', 'realizedPnlUsd', 'verifiedSwapCount',
      'decodedSwapCount', 'swapsFedToFifo', 'fifoClosedLots', 'priceEvidenceBothLegsCount',
      'missingPriceEvidenceCount', 'blockscoutFallbackUsed', 'goldrushUsed', 'alchemyRpcUsed',
      'pnlEnabledReason', 'pnlDisabledReason', 'rejectedReasonIfNotVerified',
    ]
    for (const field of required) check(`robinhoodPnlVerificationAudit carries required field "${field}"`, field in audit)
    check('source is the literal Phase 3 sidecar marker', audit.source === 'robinhood_sidecar_phase3')
    check('chainId is Robinhood 4663, never 1 or 8453', audit.chainId === 4663)
    check('goldrushUsed is true when holdings came back ok from GoldRush', audit.goldrushUsed === true)
    check('alchemyRpcUsed is true when native balance was fetched via RPC', audit.alchemyRpcUsed === true)
    check('blockscoutFallbackUsed is false when GoldRush already returned data', audit.blockscoutFallbackUsed === false)
    check('decodedSwapCount counts real decoded swaps, never transfers', audit.decodedSwapCount === 2)
    check('priceEvidenceBothLegsCount counts swaps with both-leg prices', audit.priceEvidenceBothLegsCount === 2)
    check('fifoClosedLots is the FIFO matched-lot count, never a holdings delta', audit.fifoClosedLots === 10)
    check('swapsFedToFifo is the PnL-gate verifiedSwapCount, never activity transfer volume', audit.swapsFedToFifo === 12)
    check('a fully-proved Phase 3 audit is verified', robinhoodPnlVerificationAuditProvesVerified(audit) === true)
  }

  // ── 2. Robinhood verified requires verifiedSwapCount > 0 ─────────────────────────────────────
  {
    const audit = buildRobinhoodPnlVerificationAudit({
      wallet: WALLET, holdings: holdingsOk(),
      activity: activityWith({
        swapDecodeAudits: [verifiedAudit('0xswap1', V4_NATIVE_CURRENCY_ADDRESS, TOKEN_A, '1', '1')],
      }),
      pnl: { status: 'verified', realizedPnlUsd: 5, matchedLotsCount: 10, verifiedSwapCount: 0, reason: null },
    })
    check('claimed verified with verifiedSwapCount 0 is rewritten off verified on the audit', audit.status !== 'verified')
    check('proof helper refuses verifiedSwapCount 0', robinhoodPnlVerificationAuditProvesVerified(audit) === false)
    check(
      'UI lane is not_verified when verifiedSwapCount is 0 even if pnl.status claims verified',
      selectRobinhoodPnlLaneStatus({
        ok: true,
        pnl: { status: 'verified', realizedPnlUsd: 5, verifiedSwapCount: 0 },
        robinhoodPnlVerificationAudit: { ...audit, source: ROBINHOOD_PNL_PHASE3_SOURCE, chainId: 4663, status: 'verified', verifiedSwapCount: 0, swapsFedToFifo: 0, fifoClosedLots: 10, priceEvidenceBothLegsCount: 1, realizedPnlUsd: 5 },
      }) === 'not_verified',
    )
  }

  // ── 3. Robinhood verified requires realizedPnlUsd !== null ───────────────────────────────────
  {
    const audit = buildRobinhoodPnlVerificationAudit({
      wallet: WALLET, holdings: holdingsOk(),
      activity: activityWith({
        swapDecodeAudits: [verifiedAudit('0xswap1', V4_NATIVE_CURRENCY_ADDRESS, TOKEN_A, '1', '1')],
        verifiedSwapCount: 1,
      }),
      pnl: { status: 'verified', realizedPnlUsd: null, matchedLotsCount: 10, verifiedSwapCount: 2, reason: null },
    })
    check('claimed verified with null realizedPnlUsd is rewritten off verified', audit.status !== 'verified')
    check(
      'UI lane is not_verified when realizedPnlUsd is null',
      selectRobinhoodPnlLaneStatus(phase3Lane({ realizedPnlUsd: null, status: 'verified' })) === 'not_verified',
    )
  }

  // ── 4. Robinhood verified requires Phase 3 source marker ─────────────────────────────────────
  {
    check(
      'UI lane is not_verified when the source marker is missing entirely',
      selectRobinhoodPnlLaneStatus({
        ok: true,
        pnl: { status: 'verified', realizedPnlUsd: 27542.22, verifiedSwapCount: 12 },
      }) === 'not_verified',
    )
    check(
      'UI lane is not_verified when source is a forged non-Phase-3 string',
      selectRobinhoodPnlLaneStatus(phase3Lane({ source: 'v2_worker' })) === 'not_verified',
    )
    check(
      'UI lane is not_verified when chainId is Base 8453 pretending to be Robinhood',
      selectRobinhoodPnlLaneStatus(phase3Lane({ chainId: 8453 })) === 'not_verified',
    )
    check(
      'UI lane is verified only with the exact robinhood_sidecar_phase3 marker on chain 4663',
      selectRobinhoodPnlLaneStatus(phase3Lane()) === 'verified',
    )
  }

  // ── 5. Robinhood verified requires both-leg price evidence ───────────────────────────────────
  {
    const decodedNoPrices = {
      wallet: WALLET, chainId: 4663, txHash: '0xswap1', logsSeen: 1, swapLogsSeen: 1,
      routerMatched: null, poolMatched: ROBINHOOD_V4_POOL_MANAGER, decodedSwap: true,
      tokenIn: V4_NATIVE_CURRENCY_ADDRESS, tokenOut: TOKEN_A, amountIn: '1', amountOut: '1',
      quoteLeg: 'native_eth', priceEvidence: false, confidence: 'medium', rejectedReason: 'no prices',
    }
    const audit = buildRobinhoodPnlVerificationAudit({
      wallet: WALLET, holdings: holdingsOk(),
      activity: activityWith({ swapDecodeAudits: [decodedNoPrices], verifiedSwapCount: 0 }),
      pnl: { status: 'verified', realizedPnlUsd: 5, matchedLotsCount: 10, verifiedSwapCount: 2, reason: null },
    })
    check('decoded swaps without both-leg prices do not verify', audit.status !== 'verified')
    check('missingPriceEvidenceCount counts decoded swaps that lack both-leg prices', audit.missingPriceEvidenceCount === 1)
    check('priceEvidenceBothLegsCount is 0 when no swap had both-leg prices', audit.priceEvidenceBothLegsCount === 0)
    check(
      'UI lane is not_verified when priceEvidenceBothLegsCount is 0',
      selectRobinhoodPnlLaneStatus(phase3Lane({ priceEvidenceBothLegsCount: 0 })) === 'not_verified',
    )
  }

  // ── 6. Blockscout-only evidence does not verify PnL ──────────────────────────────────────────
  {
    const transferOnlyBlockscout = activityWith({
      items: [{ txHash: '0xt1', blockTimestamp: null, kind: 'token_transfer', direction: 'incoming', counterparty: null, tokenAddress: TOKEN_A, tokenSymbol: 'RHT', rawAmount: '1' }],
      swapDecodeAudits: [], verifiedSwapCount: 0,
      blockscoutEvidence: {
        blockscoutAttempted: true, blockscoutSucceeded: true, blockscoutFallbackUsed: true,
        blockscoutStatus: 'ok', blockscoutError: null, blockscoutVerifiedSwap: false,
      },
      blockscoutSkippedReason: null,
    })
    const pnl = await resolveRobinhoodWalletPnl(WALLET, transferOnlyBlockscout, {
      fetchImpl: async () => { throw new Error('PnL must not fetch anything for transfer-only Blockscout activity') },
    })
    check('Blockscout-only transfer activity leaves PnL disabled', pnl.status === 'disabled' && pnl.realizedPnlUsd === null && pnl.verifiedSwapCount === 0)
    const audit = buildRobinhoodPnlVerificationAudit({
      wallet: WALLET, holdings: holdingsOk(), activity: transferOnlyBlockscout, pnl,
    })
    check('Blockscout-only audit records the fallback honestly', audit.blockscoutFallbackUsed === true)
    check('Blockscout-only audit is not verified', audit.status !== 'verified' && robinhoodPnlVerificationAuditProvesVerified(audit) === false)
    check(
      'UI lane is not_verified for Blockscout-only activity even if pnl.status is forged verified',
      selectRobinhoodPnlLaneStatus({
        ok: true,
        pnl: { status: 'verified', realizedPnlUsd: 27542.22, verifiedSwapCount: 12 },
        robinhoodPnlVerificationAudit: { ...audit, source: ROBINHOOD_PNL_PHASE3_SOURCE, chainId: 4663, status: 'verified', realizedPnlUsd: 27542.22, verifiedSwapCount: 12, swapsFedToFifo: 12, fifoClosedLots: 10, priceEvidenceBothLegsCount: 0 },
      }) === 'not_verified',
    )
  }

  // ── 7. Transfer-only Robinhood activity does not verify PnL ──────────────────────────────────
  {
    const transferOnly = activityWith({
      items: Array.from({ length: 50 }, (_, i) => ({
        txHash: `0x${i}`, blockTimestamp: null, kind: 'token_transfer',
        direction: i % 2 === 0 ? 'incoming' : 'outgoing', counterparty: null,
        tokenAddress: TOKEN_A, tokenSymbol: 'RHT', rawAmount: '1',
      })),
    })
    const pnl = await resolveRobinhoodWalletPnl(WALLET, transferOnly, {
      fetchImpl: async () => { throw new Error('PnL must not fetch anything for transfer-only activity') },
    })
    check('transfer-only activity never enables PnL, regardless of volume', pnl.status === 'disabled' && pnl.realizedPnlUsd === null)
    const audit = buildRobinhoodPnlVerificationAudit({ wallet: WALLET, holdings: holdingsOk(), activity: transferOnly, pnl })
    check('transfer-only audit has zero decoded swaps, zero FIFO lots, zero price evidence', audit.decodedSwapCount === 0 && audit.fifoClosedLots === 0 && audit.priceEvidenceBothLegsCount === 0)
    check('transfer-only audit is not verified', robinhoodPnlVerificationAuditProvesVerified(audit) === false)
  }

  // ── 8. Base/ETH V2 PnL cannot populate Robinhood lane ────────────────────────────────────────
  {
    check('selectRobinhoodPnlLaneStatus never reads pnlV2 — a fat V2 result with no robinhoodResult is unavailable', selectRobinhoodPnlLaneStatus(null) === 'unavailable')
    check(
      'a Robinhood-shaped object whose only number is a V2-looking realized figure, with no Phase 3 audit, is not_verified',
      selectRobinhoodPnlLaneStatus({ ok: true, pnl: { status: 'verified', realizedPnlUsd: 27542.22, verifiedSwapCount: 99 } }) === 'not_verified',
    )
    check("V2 [chain-call-audit] in fetchHoldings.ts still has no robinhood/4663 — V2 cannot produce the Robinhood lane", !/robinhood/i.test(holdingsSrc) && !/4663/.test(holdingsSrc))
    check("the worker still identifies Robinhood as a sidecar, not part of V2 chain-call-audit", workerSrc.includes("calledVia: 'sidecar_scanRobinhoodWallet'") && workerSrc.includes('partOfV2WorkerChainCallAudit: false'))
    check('robinhoodPnlVerificationAudit is built in the sidecar scanner, not in fetchHoldings / fifoEngine / pnlV2', scannerSrc.includes('export function buildRobinhoodPnlVerificationAudit') && !holdingsSrc.includes('buildRobinhoodPnlVerificationAudit'))
    check('the Robinhood route attaches robinhoodPnlVerificationAudit from the sidecar scan, never from V2', routeSrc.includes('robinhoodPnlVerificationAudit: pnlVerificationAudit'))
  }

  // ── 9. If source marker missing, UI shows Robinhood not verified ─────────────────────────────
  {
    check('buildWalletPnlViewModel\'s compact proof is gated on robinhoodLane === \'verified\' AND a real audit (missing proof cannot render it)', viewModelSrc.includes("robinhoodLane === 'verified' && audit"))
    check('PnlStatusCard not-verified copy uses the shared ROBINHOOD_PNL_NOT_VERIFIED_REASON', pnlCardSrc.includes('ROBINHOOD_PNL_NOT_VERIFIED_REASON'))
    check('Robinhood tab not-verified copy is the exact required sentence', rhSectionSrc.includes(ROBINHOOD_PNL_NOT_VERIFIED_REASON))
    check('Robinhood tab refuses verified without selectRobinhoodPnlLaneStatus', rhSectionSrc.includes('const robinhoodPnlVerified = selectRobinhoodPnlLaneStatus(result) === \'verified\''))
  }

  // ── 10. CORTEX and UI use the same Robinhood lane status ─────────────────────────────────────
  {
    check('CORTEX (buildCortexReadV2) calls selectRobinhoodPnlLaneStatus with the real robinhoodResult', pageSrc.includes('const robinhoodPnlLane = selectRobinhoodPnlLaneStatus(robinhoodResult)'))
    check('buildWalletPnlViewModel (called by both PnlStatusCard and CORTEX) calls selectRobinhoodPnlLaneStatus', viewModelSrc.includes('const robinhoodLane = selectRobinhoodPnlLaneStatus(robinhoodResult)'))
    check('the Robinhood tab calls the same selectRobinhoodPnlLaneStatus', rhSectionSrc.includes('selectRobinhoodPnlLaneStatus(result)'))
    check('the selector lives in one file (RobinhoodChainSection) and is re-exported from PnlStatusCard — no second independent gate', /export function selectRobinhoodPnlLaneStatus\(/.test(rhSectionSrc) && /export \{ selectRobinhoodPnlLaneStatus/.test(pnlCardSrc))
  }

  // ── 11. Compact proof only when verified; decoder/FIFO gates not loosened ────────────────────
  {
    check('compact proof lists Verified swaps', viewModelSrc.includes('verifiedSwaps: audit.verifiedSwapCount') && rhSectionSrc.includes('Verified swaps: {pnlAudit.verifiedSwapCount}'))
    check('compact proof lists Closed lots', viewModelSrc.includes('closedLots: audit.fifoClosedLots') && rhSectionSrc.includes('Closed lots: {pnlAudit.fifoClosedLots}'))
    check('compact proof states both-leg price evidence', viewModelSrc.includes("priceEvidence: 'both legs verified'") && rhSectionSrc.includes('Price evidence: both legs verified'))
    check('compact proof names Source: Robinhood Phase 3 sidecar', viewModelSrc.includes("source: 'Phase 3 sidecar'") && rhSectionSrc.includes('Source: Robinhood Phase 3 sidecar'))
    check('resolveRobinhoodWalletPnl still starts from confidence === \'high\' only — gate not loosened', /const verified = activity\.swapDecodeAudits\.filter\(\(a\) => a\.confidence === 'high'\)/.test(scannerSrc))
    check('resolveRobinhoodWalletPnl still drops a swap when either re-checked price is missing', scannerSrc.includes('if (tokenInPriceUsd == null || tokenInPriceUsd <= 0 || tokenOutPriceUsd == null || tokenOutPriceUsd <= 0) continue'))
    check('scanRobinhoodWallet logs [robinhoodPnlVerificationAudit] on every sidecar scan', scannerSrc.includes("console.log('[robinhoodPnlVerificationAudit]', pnlVerificationAudit)"))
    check('worker logs [CU-TRACK] robinhoodPnlVerificationAudit separately from V2 chain-call-audit', workerSrc.includes("console.warn('[CU-TRACK] robinhoodPnlVerificationAudit:', robinhoodPnlVerificationAudit)"))
  }

  console.log(`test-robinhood-pnl-verification-audit.mjs: all ${passed} assertions passed`)
}

run()
