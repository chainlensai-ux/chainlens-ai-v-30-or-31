import fs from 'node:fs'
import assert from 'node:assert/strict'

const moralis = fs.readFileSync('lib/server/moralis.ts', 'utf8')
const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// Task 1: Moralis paginated transfers — caps, stop reasons, never-throw shape.
assert.match(moralis, /export async function fetchMoralisTransfersPaginated\(/, 'fetchMoralisTransfersPaginated is exported')
assert.match(moralis, /maxEvents = adminOverride \? Math\.min\(5000,/, 'admin override required to exceed default cap')
assert.match(moralis, /Math\.min\(1500, Math\.max\(500,/, 'default cap is bounded between 500 and 1500')
for (const reason of ['cursor_null', 'event_cap', 'page_cap', 'budget_cap', 'fetch_failed', 'not_configured']) {
  assert.match(moralis, new RegExp(`'${reason}'`), `stoppedReason union includes ${reason}`)
}
assert.match(moralis, /try \{\s*page = await fetchMoralisTransfers/, 'pagination loop wraps each page fetch in try/catch (never throws)')

// Task 2: Alchemy Base pagination — page cap 3-5, Base only.
assert.match(snap, /async function fetchAlchemyBaseTransfersPaginated\(/, 'fetchAlchemyBaseTransfersPaginated exists')
assert.match(snap, /Math\.min\(5, Math\.max\(1, opts\?\.maxPages \?\? 3\)\)/, 'Alchemy pagination capped between 1 and 5 pages, default 3')

// Task 3: unified normalization.
assert.match(snap, /type UnifiedTransferEvent = \{/, 'UnifiedTransferEvent type declared')
for (const field of ['source:', 'chainId:', 'txHash:', 'logIndex:', 'tokenAddress:', 'fromAddress:', 'toAddress:', 'amountRaw:', 'amountDecimal:', 'direction:', 'walletSide:', 'valueUsd:', 'sourceConfidence:']) {
  assert.match(snap, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `UnifiedTransferEvent exposes ${field}`)
}
assert.match(snap, /function normalizeTransferEvent\(/, 'normalizeTransferEvent helper exists')

// Task 4: strict dedupe reuses existing dedupe/order infra, never random synthetic index.
assert.match(snap, /assignSyntheticLogIndex\(_p20AllNewEvents\)\.events/, 'Phase 20 merge uses deterministic synthetic log-index assignment')
assert.match(snap, /pnlEventDedupeKey\(e\)/, 'Phase 20 merge dedupes via existing pnlEventDedupeKey')
assert.match(snap, /events = deterministicEventOrder\(_p20Merged\)/, 'merged events are re-sorted deterministically')

// Task 5/6: gating — only deep/recovery scans trigger Moralis-first; normal scan path untouched.
assert.match(snap, /_p20ShouldRun = \(\s*\(deepScan \|\| deepActivity\) &&/, 'Moralis-first only runs for deep/recovery scans')
assert.match(snap, /Boolean\(process\.env\.MORALIS_API_KEY\)/, 'Moralis path requires API key configured')

// Task 7: budget accounting exposed on snapshot.
assert.match(snap, /walletHistoricalSourceBudget\?:\s*\{/, 'walletHistoricalSourceBudget type declared on WalletSnapshot')
for (const field of ['moralisAttempted', 'moralisPagesUsed', 'moralisEventsFetched', 'alchemyPagesUsed', 'goldRushBackupUsed', 'creditsUsedEstimate', 'hardCapHit', 'stoppedReason']) {
  assert.match(snap, new RegExp(`${field}:`), `walletHistoricalSourceBudget exposes ${field}`)
}
assert.match(snap, /walletSourceMergeDebug: _walletSourceMergeDebug,/, 'walletSourceMergeDebug wired to snapshot output')
assert.match(snap, /walletHistoricalSourceBudget: _walletHistoricalSourceBudget,/, 'walletHistoricalSourceBudget wired to snapshot output')

console.log('wallet source pagination + normalization checks passed')
