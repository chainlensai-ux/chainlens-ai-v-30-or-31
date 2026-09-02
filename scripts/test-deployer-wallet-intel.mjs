// TESTS — Cluster Map deployer wallet detail fix (lib/deployerWalletIntel.ts). Pure/synchronous
// resolver, no network. Covers the 10 scenarios required by the task spec: holder found/not-found/
// unavailable, transfer edge found/not-found, cheap-balance-call updates supply position, wrong-chain
// data rejected, full Wallet Scanner never auto-run, "Run Deployer Wallet Scan" CTA target, and no
// raw "Open check" remaining once a clearer state exists.

import assert from 'node:assert/strict'
import { resolveDeployerWalletIntel } from '../lib/deployerWalletIntel.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const CHAIN = 'base'
const TOKEN = '0xtoken0000000000000000000000000000000001'
const DEPLOYER = '0xdeployer000000000000000000000000000001'

// ─── 1. Deployer found in holders shows balance, supply %, rank ────────────────────────────────
{
  const { intel, audit } = resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { available: true, topHolders: [{ address: DEPLOYER, rank: 3, percent: 12.5 }] },
    devControlResult: null,
  })
  check('deployer found in holders -> supply label shows percent', intel.supplyLabel === 'Holds 12.50% of supply')
  check('deployer found in holders -> holder rank label shows rank', intel.holderRankLabel === 'Rank #3 in indexed holders')
  check('audit records deployerFoundInHolders true', audit.deployerFoundInHolders === true)
  check('audit records supply percent and rank', audit.deployerSupplyPercent === 12.5 && audit.deployerHolderRank === 3)
}

// ─── 2. Deployer NOT in indexed holders -> "not in indexed top holders" ────────────────────────
{
  const { intel, audit } = resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { available: true, topHolders: [{ address: '0xother', rank: 1, percent: 40 }] },
    devControlResult: null,
  })
  check('not in indexed holders -> holder rank label', intel.holderRankLabel === 'Not in indexed holder rows')
  check('not in indexed holders -> supply label', intel.supplyLabel === 'Not in indexed holder rows')
  check('audit deployerFoundInHolders false', audit.deployerFoundInHolders === false)
}

// ─── 3. Holder snapshot missing -> "holder data unavailable" ───────────────────────────────────
{
  const { intel, audit } = resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { available: false, topHolders: [] },
    devControlResult: null,
  })
  check('holder snapshot missing -> supply label', intel.supplyLabel === 'Holder data unavailable')
  check('holder snapshot missing -> holder rank label', intel.holderRankLabel === 'Holder list unavailable')
  check('audit holderSnapshotAvailable false', audit.holderSnapshotAvailable === false)
}

// ─── 4. Transfer edge found -> linked wallet / transfer path shown ─────────────────────────────
{
  const { intel, audit } = resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { available: false, topHolders: [] },
    transferEdges: [{ source: DEPLOYER, target: '0xlinked1', type: 'deployer_to_linked', reason: 'token_supply_transfer', confidence: 'high' }],
    devControlResult: null,
  })
  check('transfer edge found -> transferLinksLabel mentions a link', /1 transfer link/.test(intel.transferLinksLabel))
  check('transfer edge found -> linkedWallets includes the other wallet', intel.linkedWallets.some(w => w.address === '0xlinked1'))
  check('audit transferEdgesChecked = 1', audit.transferEdgesChecked === 1)
}

// ─── 5. No transfer edge -> exact required wording ──────────────────────────────────────────────
{
  const { intel } = resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { available: false, topHolders: [] },
    transferEdges: [],
    clusterMap: { nodes: [{ address: DEPLOYER, id: 'n1' }] },
    devControlResult: null,
  })
  check('no transfer edge -> exact required copy', intel.transferLinksLabel === 'No transfer links found in current cluster map.')
}

// ─── 6. Cheap balance call result updates supply position (isCurrentHolder) ────────────────────
{
  const notFound = resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { available: true, topHolders: [] },
    devControlResult: null,
    cheapBalance: { attempted: false, succeeded: false, balance: null },
  })
  check('no cheap balance -> isCurrentHolder unknown when not in holders', notFound.intel.isCurrentHolder === 'unknown')

  const found = resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { available: true, topHolders: [] },
    devControlResult: null,
    cheapBalance: { attempted: true, succeeded: true, balance: 500_000 },
  })
  check('cheap balance call succeeds with balance>0 -> isCurrentHolder yes', found.intel.isCurrentHolder === 'yes')
  check('cheap balance call -> deployerBalance recorded in audit', found.audit.deployerBalance === 500_000)
  check('cheap balance call -> audit attempted/succeeded true', found.audit.cheapBalanceCallAttempted === true && found.audit.cheapBalanceCallSucceeded === true)

  const zero = resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { available: true, topHolders: [] },
    devControlResult: null,
    cheapBalance: { attempted: true, succeeded: true, balance: 0 },
  })
  check('cheap balance call succeeds with balance=0 and confirmed absent from holders -> isCurrentHolder no', zero.intel.isCurrentHolder === 'no')
}

// ─── 7. Wrong-chain holder data rejected ────────────────────────────────────────────────────────
{
  const { intel, audit } = resolveDeployerWalletIntel({
    chainSlug: 'base',
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { chain: 'eth', available: true, topHolders: [{ address: DEPLOYER, rank: 1, percent: 50 }] },
    devControlResult: null,
  })
  check('wrong-chain holder snapshot is rejected, not used', intel.supplyLabel !== 'Holds 50.00% of supply')
  check('audit flags the wrong-chain rejection', audit.missingReasons.includes('holder_snapshot_wrong_chain_rejected'))
  check('audit holderSnapshotAvailable false after rejection', audit.holderSnapshotAvailable === false)
}

// ─── 8. Expensive full wallet scan is never auto-run (resolver is pure/sync, no network) ───────
{
  let fetchCalled = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = (...args) => { fetchCalled = true; return originalFetch ? originalFetch(...args) : Promise.reject(new Error('no fetch')) }
  resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { available: true, topHolders: [{ address: DEPLOYER, rank: 1, percent: 10 }] },
    devControlResult: { previousProjects: [{ contractAddress: '0xprev1', name: 'Prev', symbol: 'PRV', createdAt: null, rugFlag: false }] },
  })
  globalThis.fetch = originalFetch
  check('resolver never calls fetch/network on its own', fetchCalled === false)
}

// ─── 9. "Run Deployer Wallet Scan" CTA target — verified at the UI-source-text level (structural) ─
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  assert.match(src, /Run Deployer Wallet Scan/, 'CTA button label present')
  assert.match(src, /wallet-scanner\?address=\$\{selectedClusterNode\.address\}&chain=\$\{chain/, 'CTA navigates with deployer address + chain')
  const scannerSrc = fs.readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')
  assert.match(scannerSrc, /params\.get\('address'\)/, 'Wallet Scanner reads ?address= from the URL')
  assert.doesNotMatch(scannerSrc, /handleScan\(\)\s*$/m, 'prefill effect does not itself invoke handleScan')
  passed += 3
}

// ─── 10. No raw "Open check" remains when a clearer state exists ───────────────────────────────
{
  const { intel } = resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holderSnapshot: { available: true, topHolders: [{ address: DEPLOYER, rank: 2, percent: 30 }] },
    transferEdges: [{ source: DEPLOYER, target: '0xlinked1', type: 'deployer_to_linked', reason: 'token_supply_transfer', confidence: 'high' }],
    devControlResult: null,
  })
  const serialized = JSON.stringify(intel)
  check('resolved deployer intel never contains the raw string "Open check"', !/Open check/i.test(serialized))
}

// ─── Deployer address unresolved -> honest empty-state, not a fabricated result ─────────────────
{
  const { intel, audit } = resolveDeployerWalletIntel({
    chainSlug: CHAIN,
    tokenAddress: TOKEN,
    deployerAddress: null,
    devControlResult: null,
  })
  check('unresolved deployer -> open_check confidence, no invented address', intel.confidence === 'open_check' && intel.deployerAddress === '')
  check('unresolved deployer -> audit missingReasons flags it', audit.missingReasons.includes('deployer_address_unresolved'))
}

console.log(`test-deployer-wallet-intel: ${passed} checks passed`)
