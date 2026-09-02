// Token Scanner Dev Map / Cluster Wallets diagnosis.
// Pure classification + mocked providers. No live network.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  classifyAlchemyRpcError,
  alchemyShouldSkipAndNotRetry,
  separateFactoryAndOrigin,
  deriveHolderConcentrationFromTransfers,
  creatorInTopHoldersFromRows,
  clusterSupplyFromHolders,
  linkedWalletsFromTransfers,
  buildDevClusterCacheKey,
  isDevClusterCacheHitValid,
  buildDevMapUiLabels,
  finalizeDevClusterStatuses,
  emptyDevClusterDiagnosisAudit,
  linkedWalletDisplayLabel,
} = await import('../lib/devClusterDiagnosis.ts')

const { resolveDevClusterDiagnosis } = await import('../lib/server/devClusterDiagnosis.ts')

const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const routeSrc = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed += 1
}

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ORIGIN = '0x1111111111111111111111111111111111111111'
const FACTORY = '0x2222222222222222222222222222222222222222'
const WALLET_A = '0x3333333333333333333333333333333333333333'
const WALLET_B = '0x4444444444444444444444444444444444444444'
const ZERO = '0x0000000000000000000000000000000000000000'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// ── 1. Alchemy 400 skip, never retry ───────────────────────────────────────
{
  const skipped = classifyAlchemyRpcError({ httpStatus: 400, jsonError: { code: -32602, message: 'invalid-param' } })
  check('Alchemy 400 is skipped', skipped.skipped === true)
  check('Alchemy 400 does not retry', alchemyShouldSkipAndNotRetry(skipped) === true)
  check('Alchemy 400 health is invalid_param', skipped.health === 'invalid_param')

  const unsupported = classifyAlchemyRpcError({ jsonError: { code: -32601, message: 'chain not supported' } })
  check('Alchemy chain-not-supported is skipped', unsupported.skipped === true && unsupported.health === 'chain_not_supported')
}

// ── 2. Alchemy billing / rate-limit exact reason ───────────────────────────
{
  const billing = classifyAlchemyRpcError({ httpStatus: 402, message: 'monthly capacity exceeded' })
  check('Alchemy billing disabled flag', billing.billingDisabled === true && billing.health === 'billing_disabled')
  const rate = classifyAlchemyRpcError({ httpStatus: 429, message: 'rate limit' })
  check('Alchemy rate limited flag', rate.rateLimited === true && rate.health === 'rate_limited')
  const timeout = classifyAlchemyRpcError({ timedOut: true, message: 'timeout' })
  check('Alchemy timeout flag', timeout.timeout === true && timeout.health === 'timeout')
}

// ── 3. Transfer-derived holders compute top1/top10/top20 ───────────────────
{
  const derived = deriveHolderConcentrationFromTransfers([
    { from: ZERO, to: WALLET_A, amountRaw: '800' },
    { from: ZERO, to: WALLET_B, amountRaw: '200' },
    { from: WALLET_A, to: ORIGIN, amountRaw: '100' },
  ], TOKEN, '1000')
  check('transfer-derived exists', derived != null)
  check('top1 from transfers is not fake 0', derived.top1Pct != null && derived.top1Pct > 0)
  check('top10 from transfers covers observed supply', derived.top10Pct != null && derived.top10Pct > derived.top1Pct)
  check('top20 from transfers is computed', derived.top20Pct != null)
  check('transfer-derived is partial', derived.partial === true)
  check('missing transfers do not become 0%', deriveHolderConcentrationFromTransfers([], TOKEN, '1000') == null)
}

// ── 4. Creator in top holders ──────────────────────────────────────────────
{
  const holders = [
    { address: ORIGIN, percent: 40, rank: 1 },
    { address: WALLET_A, percent: 10, rank: 2 },
  ]
  check('creator in top holders is true when rows exist', creatorInTopHoldersFromRows(holders, ORIGIN) === true)
  check('creator in top holders is false when absent', creatorInTopHoldersFromRows(holders, WALLET_B) === false)
  check('creator in top holders is null without origin', creatorInTopHoldersFromRows(holders, null) === null)
  check('cluster supply sums origin + linked', clusterSupplyFromHolders(holders, ORIGIN, [{ address: WALLET_A }]) === 50)
}

// ── 5. Factory vs origin never mixed ───────────────────────────────────────
{
  const split = separateFactoryAndOrigin({
    creatorAddress: FACTORY,
    creatorIsContract: true,
    creationTxFrom: ORIGIN,
    tokenAddress: TOKEN,
  })
  check('factory detected', split.factoryDetected === true)
  check('factory address is the contract creator', split.factoryAddress === FACTORY)
  check('origin is creation tx from, not factory', split.originAddress === ORIGIN)
  check('factory is never origin', split.originAddress !== split.factoryAddress)

  const eoa = separateFactoryAndOrigin({
    creatorAddress: ORIGIN,
    creatorIsContract: false,
    creationTxFrom: ORIGIN,
    tokenAddress: TOKEN,
  })
  check('EOA creator is origin, no factory', eoa.originAddress === ORIGIN && eoa.factoryAddress == null)
}

// ── 6. Cache isolation Base/ETH/BNB/Robinhood ──────────────────────────────
{
  const baseKey = buildDevClusterCacheKey(8453, TOKEN)
  const rhKey = buildDevClusterCacheKey(4663, TOKEN)
  check('Base and Robinhood cache keys differ', baseKey !== rhKey)
  check('ETH and BNB cache keys differ', buildDevClusterCacheKey(1, TOKEN) !== buildDevClusterCacheKey(56, TOKEN))
  check('Base cache cannot populate Robinhood', isDevClusterCacheHitValid(
    { chainId: 8453, tokenAddress: TOKEN },
    { chainId: 4663, tokenAddress: TOKEN },
  ) === false)
  check('same chain+token is a valid hit', isDevClusterCacheHitValid(
    { chainId: 4663, tokenAddress: TOKEN },
    { chainId: 4663, tokenAddress: TOKEN.toUpperCase() },
  ) === true)
}

// ── 7. Graph not run vs ran-none UI ────────────────────────────────────────
{
  const audit = emptyDevClusterDiagnosisAudit(4663, 'robinhood', TOKEN)
  audit.linkedWalletGraph.graphStatus = 'not_run'
  audit.linkedWalletGraph.failureReason = 'Alchemy invalid param — skipped'
  audit.linkedWalletGraph.walletsMapped = null
  const labels = buildDevMapUiLabels(audit)
  check('graph not run does not say 0 mapped', !labels.linkedLabel.includes('0 mapped'))
  check('graph not run explains why', labels.linkedLabel.includes('Linked wallet graph not run'))

  audit.linkedWalletGraph.graphStatus = 'ran_none'
  audit.linkedWalletGraph.walletsMapped = 0
  audit.linkedWalletGraph.failureReason = null
  const ranNone = buildDevMapUiLabels(audit)
  check('graph ran none can show 0 confirmed', ranNone.linkedLabel === '0 confirmed')
  check('graph ran none still not 0 mapped', !ranNone.linkedLabel.includes('0 mapped'))
}

// ── 8. No final generic Open Check in labels ───────────────────────────────
{
  const audit = emptyDevClusterDiagnosisAudit(8453, 'base', TOKEN)
  const finals = finalizeDevClusterStatuses(audit)
  const labels = buildDevMapUiLabels({ ...audit, ...finals })
  for (const v of Object.values(labels)) {
    check(`UI label is not Open Check: ${v}`, !/open check/i.test(String(v)))
  }
  check('limited signal is gone', !/limited signal/i.test(labels.deployerLabel))
}

// ── 9. Alchemy fails, Blockscout creator works ─────────────────────────────
{
  let alchemyCalls = 0
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.includes('alchemy') || (init?.method === 'POST' && u.includes('g.alchemy.com'))) {
      alchemyCalls += 1
      return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid-param' } }, 400)
    }
    if (u.includes('robinhoodchain.blockscout.com/api/v2/addresses/') && u.endsWith(TOKEN)) {
      return jsonResponse({ creator_address_hash: ORIGIN, creation_tx_hash: '0xabc', is_contract: true })
    }
    if (u.includes(`addresses/${ORIGIN}`)) {
      return jsonResponse({ is_contract: false, creator_address_hash: null })
    }
    if (u.includes('/transactions/0xabc')) {
      return jsonResponse({ from: { hash: ORIGIN } })
    }
    if (u.includes('/holders')) return jsonResponse({ items: [] })
    if (u.includes('/transfers')) return jsonResponse({ items: [] })
    return jsonResponse({ error: 'not_found' }, 404)
  }

  const result = await resolveDevClusterDiagnosis({
    chainSlug: 'robinhood',
    chainId: 4663,
    tokenAddress: TOKEN,
    alchemyRpcUrl: 'https://robinhood-mainnet.g.alchemy.com/v2/test',
    goldrushKey: null,
    skipNetwork: false,
    fetchImpl,
    cacheGet: async () => null,
    cacheSet: async () => {},
  })
  check('Alchemy was attempted once', alchemyCalls === 1)
  check('Alchemy 400 did not retry', alchemyCalls === 1)
  check('Blockscout creator resolved origin', result.originAddress === ORIGIN)
  check('deployer is origin not empty', result.deployerAddress === ORIGIN)
  check('audit records blockscout creator', result.audit.deployerResolution.sourcesTried.includes('blockscout_creator') || result.audit.deployerResolution.contractCreatorFound)
}

// ── 10. GoldRush fail → Alchemy fallback ───────────────────────────────────
{
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.includes('covalenthq.com')) return jsonResponse({ error: 'down' }, 500)
    if (init?.method === 'POST') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          transfers: [
            { from: ZERO, to: ORIGIN, hash: '0x1', category: 'erc20', value: 1, rawContract: { value: '1000' } },
            { from: ORIGIN, to: WALLET_A, hash: '0x2', category: 'erc20', value: 1, rawContract: { value: '400' } },
          ],
        },
      })
    }
    return jsonResponse({ items: [] }, 404)
  }
  const result = await resolveDevClusterDiagnosis({
    chainSlug: 'base',
    chainId: 8453,
    tokenAddress: TOKEN,
    alchemyRpcUrl: 'https://base-mainnet.g.alchemy.com/v2/test',
    goldrushKey: 'test-key',
    fetchImpl,
    cacheGet: async () => null,
    cacheSet: async () => {},
  })
  check('GoldRush failure is recorded', result.audit.providerHealth.goldrush.attempted === true)
  check('Alchemy used after GoldRush fail', result.audit.providerHealth.alchemyRpc.ok === true)
  check('origin resolved from Alchemy transfers', result.originAddress === ORIGIN)
}

// ── 11. Holder rows missing → graph unavailable, not 0 mapped ──────────────
{
  const result = await resolveDevClusterDiagnosis({
    chainSlug: 'eth',
    chainId: 1,
    tokenAddress: TOKEN,
    skipNetwork: true,
    existing: {
      deployerAddress: ORIGIN,
      holders: [],
      linkedWallets: [],
      linkedGraphStatus: 'limited_check',
      linkedGraphReason: 'rpc_not_configured',
      transfers: [],
    },
    cacheGet: async () => null,
    cacheSet: async () => {},
  })
  const label = linkedWalletDisplayLabel(result.audit.linkedWalletGraph)
  check('missing holders/graph is not 0 mapped', !label.includes('0 mapped'))
  check('walletsMapped is null when graph did not run', result.audit.linkedWalletGraph.walletsMapped == null)
  check('UI uses cluster/graph-not-run copy', /graph not run|not verified|needs/i.test(label))
}

// ── 12. Graph ran and found none → 0 confirmed ─────────────────────────────
{
  const built = linkedWalletsFromTransfers({
    transfers: [{ from: ORIGIN, to: TOKEN, amountRaw: '1', category: 'erc20' }],
    originAddress: ORIGIN,
    tokenAddress: TOKEN,
  })
  check('infra-only transfers do not invent linked wallets', built.wallets.length === 0)

  const result = await resolveDevClusterDiagnosis({
    chainSlug: 'eth',
    chainId: 1,
    tokenAddress: TOKEN,
    skipNetwork: true,
    existing: {
      deployerAddress: ORIGIN,
      holders: [{ address: WALLET_A, percent: 12 }],
      linkedWallets: [],
      linkedGraphStatus: 'none_found',
      transfers: [{ from: ORIGIN, to: TOKEN, amountRaw: '1', category: 'erc20' }],
    },
    cacheGet: async () => null,
    cacheSet: async () => {},
  })
  check('graph ran with none found', result.graphRan === true)
  check('label is 0 confirmed', linkedWalletDisplayLabel(result.audit.linkedWalletGraph) === '0 confirmed')
}

// ── 13. Alchemy billing reason surfaces in audit ───────────────────────────
{
  const fetchImpl = async (url, init) => {
    if (init?.method === 'POST') {
      return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Monthly capacity exceeded' } }, 403)
    }
    return jsonResponse({ items: [] }, 404)
  }
  const result = await resolveDevClusterDiagnosis({
    chainSlug: 'base',
    chainId: 8453,
    tokenAddress: TOKEN,
    alchemyRpcUrl: 'https://base-mainnet.g.alchemy.com/v2/test',
    goldrushKey: null,
    fetchImpl,
    existing: { linkedGraphStatus: 'skipped', holders: [], linkedWallets: [] },
    cacheGet: async () => null,
    cacheSet: async () => {},
  })
  check('billing disabled is on alchemy health', result.audit.providerHealth.alchemyRpc.billingDisabled === true)
  check('final reason names billing', /billing/i.test(result.audit.finalReason) || /billing/i.test(result.audit.linkedWalletGraph.failureReason ?? ''))
}

// ── 14. Source wiring + UI copy ────────────────────────────────────────────
{
  check('token route runs origin discovery on Base', /useOriginDiscovery = chain === 'eth' \|\| chain === 'base'/.test(routeSrc))
  check('token route attaches devClusterDiagnosisAudit', routeSrc.includes('devClusterDiagnosisAudit'))
  check('token route never treats factory as origin', routeSrc.includes('Never keep a factory contract as the origin wallet'))
  check('Dev Map UI dropped Limited signal', !pageSrc.includes("'Limited signal'"))
  check('hero linked wallets uses audit or graphRan', pageSrc.includes('clusterUi?.linkedLabel') && pageSrc.includes('graphRan'))
  check('0 confirmed is available when graph ran empty', pageSrc.includes('0 confirmed'))
  check('Dev Map UI has Origin wallet not verified', pageSrc.includes('Origin wallet not verified'))
  check('Dev Map UI has Cluster wallets not verified', pageSrc.includes('Cluster wallets not verified'))
  check('Dev Map UI has Needs holder evidence', pageSrc.includes('Needs holder evidence'))
  check('Dev Map hero no longer says Open check for supply', !/Supply Control.*Open check/.test(pageSrc.slice(pageSrc.indexOf("k:'Supply Control'"), pageSrc.indexOf("k:'Supply Control'") + 280)))
}

console.log(`test-dev-cluster-diagnosis: ${passed} checks passed`)
