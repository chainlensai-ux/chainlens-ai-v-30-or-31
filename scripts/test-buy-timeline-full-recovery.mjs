import assert from 'node:assert/strict'
import fs from 'node:fs'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// ── Wiring: buyTimeline runs after buildSwapDetection (and its pre-pricing enrichment passes)
// and strictly before buildPriceAtTimeEvidence, only when swapCandidateEvents === 0. ──
assert.match(snap, /import \{ buildBuyTimeline, type BuyTimelineResult, type BuyTimelineSourceItem \} from '\.\/buyTimeline'/, 'walletSnapshot.ts imports buildBuyTimeline from the new isolated module')
assert.match(snap, /buyTimeline\?: BuyTimelineResult/, 'WalletSnapshot type declares an optional buyTimeline field')

const buyTimelineBlockMatch = snap.match(/\/\/ ── BUY-TIMELINE \(Deep Scan \/ Full Recovery informational fallback\) [\s\S]*?\/\/ ── End BUY-TIMELINE/)
assert.ok(buyTimelineBlockMatch, 'BUY-TIMELINE integration block exists')
const buyTimelineBlock = buyTimelineBlockMatch[0]

const priceInferenceIdx = snap.indexOf(buyTimelineBlock)
const nextPricingCallIdx = snap.indexOf("buildPriceAtTimeEvidence(_swapEvidenceWithDetection, activityRequested, _reqPriceCache, priceByContract, totalValue, scanModeConfig?.priceAttempts")
assert.ok(priceInferenceIdx > 0 && nextPricingCallIdx > priceInferenceIdx, 'BUY-TIMELINE block runs strictly before the buildPriceAtTimeEvidence call')

assert.match(buyTimelineBlock, /if \(activityRequested && deepActivity && walletSwapSummary\.swapCandidateEvents === 0\) \{/, 'buyTimeline reconstruction only runs when swapCandidateEvents === 0')
assert.match(buyTimelineBlock, /_buyTimelineResult = buildBuyTimeline\(_buyTimelineEvents, addrNorm\)/, 'buyTimeline result is computed via buildBuyTimeline')
assert.match(snap, /buyTimeline: _buyTimelineResult,/, 'buyTimeline result is attached to the final snapshot object')

// ── Full Recovery: additional bounded GoldRush + Alchemy pull, gated on scanMode === 'full_recovery'. ──
assert.match(buyTimelineBlock, /if \(walletScanBudget\?\.scanMode === 'full_recovery'\) \{/, 'the additional historical pull for buyTimeline is scoped to full_recovery scan mode only')
assert.match(buyTimelineBlock, /fetchGoldrushHistoricalPage\(addr, requestedChain === 'eth' \? 'eth-mainnet' : 'base-mainnet', GOLDRUSH_KEY, 1, 50\)/, 'full_recovery buyTimeline pulls one bounded additional GoldRush historical page')
assert.match(buyTimelineBlock, /fetchAlchemyPnlEvents\(addr, baseUrl\)/, 'full_recovery buyTimeline pulls one bounded additional Alchemy fetch')

// ── Hard constraint: this feature must NEVER call any Moralis function. ──
assert.doesNotMatch(buyTimelineBlock, /fetchMoralis\w*\(/, 'the BUY-TIMELINE integration block never calls any Moralis fetch function')
const buyTimelineModule = fs.readFileSync('lib/server/buyTimeline.ts', 'utf8')
assert.doesNotMatch(buyTimelineModule, /^import .*from ['"]\.\/moralis['"]/m, 'buyTimeline.ts never imports from ./moralis')
assert.doesNotMatch(buyTimelineModule, /fetchMoralis\w*\(/, 'buyTimeline.ts never calls any Moralis fetch function')

// ── Base (pre-Moralis-merge) event capture: buyTimeline can never see Moralis-sourced events,
// regardless of whether the (separately shipped) Moralis escalation fallback fires elsewhere. ──
const captureIdx = snap.indexOf('const _buyTimelineBaseEvents: BuyTimelineSourceItem[] = [')
const moralisFallbackCommentIdx = snap.indexOf('// Moralis activity fallback: runs only when deepActivity requested')
assert.ok(captureIdx > 0 && moralisFallbackCommentIdx > captureIdx, '_buyTimelineBaseEvents is captured before any Moralis merge/fallback logic runs')

// ── Safety: this feature never touches FIFO, pricing, integrity gates, or admin gating. ──
assert.doesNotMatch(buyTimelineBlock, /buildFifoLotEngine|publicPnlIntegrityGate|fullRecoveryAllowed/, 'BUY-TIMELINE block never touches FIFO, PnL integrity gates, or admin gating')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
assert.match(route, /const fullRecoveryAllowed = \(authInfo\.email \?\? ''\)\.toLowerCase\(\) === 'chainlensai@gmail\.com'/, 'admin gating (server-side, Bearer-token-derived) is untouched')
assert.doesNotMatch(route, /body(?:\?\.|\.)userEmail/, 'route never trusts a client-supplied email field')

console.log('test-buy-timeline-full-recovery: all assertions passed')
