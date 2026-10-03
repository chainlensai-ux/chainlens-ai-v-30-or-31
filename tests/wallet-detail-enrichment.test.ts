import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveWalletDetail, launchReceiptsFromTransfers, type WalletBalanceSnapshot } from '../lib/walletDetailEvidence'
import { createWalletBalanceReader } from '../lib/server/walletDetailBalance'
import { createWalletDetailCache } from '../lib/walletDetailCache'
import { loadSelectedWalletBalance } from '../lib/walletDetailClient'
import { resolveDeployerWalletIntel } from '../lib/deployerWalletIntel'
import { classifyTokenScannerEvidence } from '../lib/tokenScannerEvidence'
import degen from './fixtures/wallet-detail-degen-live.json'
import asteroid from './fixtures/wallet-detail-asteroid-live.json'
import { resolveDevClusterDiagnosis } from '../lib/server/devClusterDiagnosis'

const wallet = '0x1111111111111111111111111111111111111111'
const token = '0x2222222222222222222222222222222222222222'
const base = { wallet, symbol: 'TOKEN', decimals: 6, totalSupplyRaw: '1000000000000', indexAvailable: true }
const snapshot = (raw: string | null): WalletBalanceSnapshot => ({ tokenBalanceRaw: raw, tokenBalanceSucceeded: raw !== null, nativeBalance: 0.184, nativeBalanceSucceeded: true, nativeSymbol: 'ETH' })

test('real DEGEN creator outside 50 indexed rows: verified zero and native balance, no invented launch/rank', () => {
  assert.equal(degen.indexedAddresses.length, 50)
  assert.ok(!degen.indexedAddresses.some(a => a.toLowerCase() === degen.wallet))
  const after = resolveWalletDetail({ ...degen, indexAvailable: true })
  assert.equal(after.supply, '0 DEGEN · 0.00%')
  assert.equal(after.currentHolder, 'No')
  assert.equal(after.nativeBalance, '0.000108924 ETH')
  assert.equal(after.holderRank, 'Outside indexed holder set')
  assert.equal(after.launchReceipt, 'Not established')
})
test('real ASTEROID origin outside 50 indexed rows with failed live RPC stays Unknown', () => {
  assert.equal(asteroid.holderRows.length, 50)
  assert.ok(!asteroid.holderRows.some(h => h.address.toLowerCase() === asteroid.wallet))
  const after = resolveWalletDetail({ ...asteroid, decimals: Number(asteroid.decimals), indexAvailable: true })
  assert.equal(after.currentHolder, 'Unknown')
  assert.equal(after.supply, 'Unavailable')
  assert.equal(after.nativeBalance, 'Unavailable')
  assert.equal(after.launchReceipt, 'Not established')
})

test('absent from index: positive direct balance supplies amount, share and Yes without inventing rank', () => {
  const result = resolveWalletDetail({ ...base, snapshot: snapshot('12430000000') })
  assert.equal(result.supply, '12,430 TOKEN · 1.24%')
  assert.equal(result.currentHolder, 'Yes')
  assert.equal(result.holderRank, 'Outside indexed holder set')
  assert.equal(result.provenance.holderRank.status, 'not_in_indexed_set')
  assert.equal(result.provenance.tokenBalance.source, 'rpc_balanceOf')
  assert.equal(result.nativeBalance, '0.184 ETH')
})
test('successful zero is No; failure or not attempted is Unknown', () => {
  assert.equal(resolveWalletDetail({ ...base, snapshot: snapshot('0') }).currentHolder, 'No')
  assert.equal(resolveWalletDetail({ ...base, snapshot: snapshot(null) }).currentHolder, 'Unknown')
  assert.equal(resolveWalletDetail(base).currentHolder, 'Unknown')
  assert.equal(resolveWalletDetail({ ...base, snapshot: snapshot('0') }).supply, '0 TOKEN · 0.00%')
  assert.equal(resolveWalletDetail({ ...base, snapshot: snapshot('0x') }).currentHolder, 'Unknown')
})
test('indexed rank and supply snapshot survive a contradictory current zero balance', () => {
  const result = resolveWalletDetail({ ...base, indexed: { rank: 7, percent: 3.25 }, snapshot: snapshot('0') })
  assert.equal(result.holderRank, '#7')
  assert.equal(result.currentHolder, 'No')
  assert.equal(result.indexedSupply, 'Indexed snapshot: 3.25%')
  assert.equal(result.provenance.holderRank.status, 'verified')
  assert.equal(resolveWalletDetail({ ...base, indexed: { percent: 3 } }).provenance.holderRank.status, 'unavailable')
})
test('indexed holdings cannot claim a current balance after an unattempted or failed RPC', () => {
  for (const direct of [null, snapshot(null)]) {
    const result = resolveWalletDetail({ ...base, indexed: { rank: 7, percent: 12 }, snapshot: direct })
    assert.equal(result.currentHolder, 'Unknown')
    assert.equal(result.holderRank, '#7')
    assert.equal(result.supply, '12.00% of supply')
    assert.equal(result.supplySource, 'Indexed holder snapshot')
  }
  assert.equal(resolveDeployerWalletIntel({
    chainSlug: 'base', tokenAddress: token, deployerAddress: wallet,
    holderSnapshot: { available: true, topHolders: [{ address: wallet, rank: 7, percent: 12 }] },
    cheapBalance: { attempted: true, succeeded: false },
  }).intel.isCurrentHolder, 'unknown')
})
test('unverified decimals never default to 18 and tiny nonzero supply never displays as zero', () => {
  assert.equal(resolveWalletDetail({ ...base, decimals: null, snapshot: snapshot('42') }).supply, '42 base units')
  const unscaled = resolveWalletDetail({ ...base, decimals: null, indexed: { rank: 7, percent: 12 }, snapshot: snapshot('42') })
  assert.equal(unscaled.supply, '42 base units')
  assert.equal(unscaled.indexedSupply, 'Indexed snapshot: 12.00%')
  assert.equal(unscaled.holderRank, '#7')
  assert.equal(resolveWalletDetail({ ...base, snapshot: snapshot('1') }).supply, '0.000001 TOKEN · <0.01%')
  assert.equal(resolveWalletDetail({ ...base, totalSupplyRaw: null, snapshot: snapshot('1000000') }).supply, '1 TOKEN')
})
test('launch receipt requires explicit deployment/window proof, not current holdings or an undated edge', () => {
  const tx = 'deployment'
  const transfers = [
    { to: token, category: 'erc20', amountRaw: '10', txHash: tx, timestamp: '2026-01-01T00:00:00Z' },
    { to: wallet, category: 'erc20', amountRaw: '10', txHash: 'launch-transfer', timestamp: '2026-01-01T23:59:59Z' },
    { to: wallet, category: 'external', amountRaw: '10', txHash: 'funding', timestamp: '2026-01-01T00:01:00Z' },
    { to: wallet, category: 'erc20', amountRaw: '10', txHash: 'late', timestamp: '2026-01-02T00:00:01Z' },
  ]
  const receipts = launchReceiptsFromTransfers(transfers, tx)
  assert.equal(receipts.length, 2)
  assert.equal(resolveWalletDetail({ ...base, launchReceipts: receipts }).launchReceipt, 'Yes')
  assert.equal(resolveWalletDetail({ ...base, indexed: { rank: 1, percent: 100 } }).launchReceipt, 'Not established')
  assert.equal(resolveWalletDetail({ ...base, snapshot: snapshot('0') }).launchReceipt, 'Not established')
  assert.deepEqual(launchReceiptsFromTransfers(transfers, null), [])
  assert.deepEqual(launchReceiptsFromTransfers([{ ...transfers[1], timestamp: null }], tx), [])
})
test('legacy resolver no longer infers launch receipt from current holdings or recipient links', () => {
  const result = resolveDeployerWalletIntel({
    chainSlug: 'base', tokenAddress: token, deployerAddress: wallet,
    holderSnapshot: { available: true, topHolders: [{ address: wallet, rank: 7, percent: 12 }] },
    devControlResult: { linkedWallets: [{ address: token, reason: 'token_supply_transfer', amountReceived: 50 }] },
    cheapBalance: { attempted: true, succeeded: true, balance: 0 },
  }).intel
  assert.equal(result.receivedSupplyAtLaunchLabel, 'Not established')
  assert.equal(result.isCurrentHolder, 'no')
  assert.equal(result.holderRank, 7)
  const evidence = classifyTokenScannerEvidence({ holdersVerified: true, holderRows: [{ address: token }], selectedWallet: wallet })
  assert.equal(evidence.labels.currentHolder, 'Unknown')
  assert.equal(evidence.labels.receivedSupplyAtLaunch, 'Not established')
  assert.equal(classifyTokenScannerEvidence({ holdersVerified: false, holderRows: [], selectedWallet: wallet }).walletInIndexedRows, null)
})
test('existing transfer evidence reaches wallet detail without calls or becoming current-holder evidence', async () => {
  let calls = 0
  const result = await resolveDevClusterDiagnosis({
    chainSlug: 'base', chainId: 8453, tokenAddress: token, skipNetwork: true,
    fetchImpl: async () => { calls++; throw new Error('unexpected provider call') },
    existing: {
      deployerAddress: wallet, deployerStatus: 'confirmed', creationTxHash: 'deployment',
      linkedGraphStatus: 'ok', holders: [{ address: token, percent: 10, rank: 1 }],
      transfers: [{ from: token, to: wallet, category: 'erc20', amountRaw: '1', txHash: 'deployment' }],
    },
  })
  assert.equal(calls, 0)
  assert.equal(resolveWalletDetail({ ...base, launchReceipts: result.launchReceipts }).launchReceipt, 'Yes')
  assert.equal(resolveWalletDetail({ ...base, launchReceipts: result.launchReceipts }).currentHolder, 'Unknown')
  assert.ok(!result.holders.some(row => row.address === wallet))
})
test('RPC reads are lazy, singleflight, native cached across tokens, chain isolated and TTL bounded', async () => {
  const calls: string[] = []
  let now = 0
  const reader = createWalletBalanceReader(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    calls.push(body.method)
    return Response.json({ result: body.method === 'eth_call' ? '0x' + '1'.padStart(64, '0') : '0x0' })
  }, () => now)
  const config = { chainId: 8453, rpcUrl: 'https://existing-rpc.invalid', nativeSymbol: 'ETH' }
  assert.equal(calls.length, 0, 'rendering 33 graph nodes does not invoke a reader')
  const [a,b] = await Promise.all([reader(config, token, wallet), reader(config, token, wallet)])
  assert.deepEqual(a,b)
  assert.equal(calls.length, 2)
  await reader(config, token.toUpperCase(), wallet.toUpperCase())
  assert.equal(calls.length, 2, 'repeat click served from cache')
  await reader(config, wallet, wallet)
  assert.equal(calls.length, 3, 'native key excludes token')
  await reader({ ...config, chainId: 1 }, token, wallet)
  assert.equal(calls.length, 5, 'never reuse cross-chain')
  now = 60_001
  await reader(config, token, wallet)
  assert.equal(calls.length, 7)
})
test('reverts, empty return data, malformed results and HTTP errors are unavailable, not zero', async () => {
  for (const response of [{ result: '0x' }, { result: 'bad' }, { error: { code: -32000 }, result: '0x0' }]) {
    const reader = createWalletBalanceReader(async () => Response.json(response))
    const result = await reader({ chainId: 1, rpcUrl: 'https://existing-rpc.invalid', nativeSymbol: 'ETH' }, token, wallet)
    assert.equal(result.tokenBalanceSucceeded, false)
    assert.equal(resolveWalletDetail({ ...base, snapshot: result }).currentHolder, 'Unknown')
  }
  const reader = createWalletBalanceReader(async () => new Response(null, { status: 500 }))
  const result = await reader({ chainId: 1, rpcUrl: 'https://existing-rpc.invalid', nativeSymbol: 'ETH' }, token, wallet)
  assert.equal(result.nativeBalanceSucceeded, false)
})
test('client cache shares pending work and expires without turning failed loads into a successful value', async () => {
  let calls = 0, now = 0
  const cache = createWalletDetailCache<number>(60_000, 2, () => now)
  const load = async () => ++calls
  assert.deepEqual(await Promise.all([cache.get('a', load), cache.get('a', load)]), [1,1])
  await cache.get('a', load)
  assert.equal(calls, 1)
  now = 60_001
  assert.equal(await cache.get('a', load), 2)
  await assert.rejects(cache.get('b', async () => { throw new Error('failed') }))
  assert.equal(await cache.get('b', load), 3)
})
test('actual selection loader is lazy and repeat selections reuse the same fetch', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ ok: true, ...snapshot('1') })
  })
  assert.equal(calls, 0)
  const [a, b] = await Promise.all([
    loadSelectedWalletBalance('base', token, wallet),
    loadSelectedWalletBalance('base', token, wallet),
  ])
  assert.equal(a.nativeBalance, 0.184)
  assert.deepEqual(a, b)
  await loadSelectedWalletBalance('base', token, wallet)
  assert.equal(calls, 1)
})
test('UI wiring enriches only the selected wallet and consumes native results, metadata and provenance', () => {
  const page = readFileSync('app/terminal/token-scanner/page.tsx', 'utf8')
  const panel = page.slice(page.indexOf('function ClusterMapPanel('), page.indexOf('function SolanaClusterGraphPanel('))
  assert.match(panel, /if \(!selectedBalanceAddress \|\| !chain \|\| !tokenAddress\) return/)
  assert.equal((panel.match(/loadSelectedWalletBalance\(/g) ?? []).length, 1)
  assert.match(panel, /walletBalanceState\?\.key === balanceKey/)
  assert.match(panel, /if \(!cancelled\) setWalletBalanceState/)
  assert.match(panel, /selectedWalletDetail.nativeBalance/)
  assert.match(panel, /selectedWalletDetail.provenance/)
  assert.doesNotMatch(panel, /node.type !== 'deployer'\) return/)
  assert.doesNotMatch(readFileSync('lib/server/walletDetailBalance.ts','utf8'), /goldrush|moralis|alchemy_getAssetTransfers/i)
})
