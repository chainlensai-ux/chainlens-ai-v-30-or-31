// Launch attribution (shadow mode): verified creator, launch initiator and launchpad infrastructure stay distinct;
// an initiator is never proposed as the developer without independent evidence; missing evidence leaves the
// existing selection alone and is reported. Fixtures are the real Base creation transactions, trimmed to the
// token's Transfer logs, with bytecode reduced to a non-empty marker.
//   npx tsx --test tests/launch-attribution-shadow.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildLaunchAttributionShadow, classifyLaunchAttribution, collectLaunchAttributionEvidence, createLaunchAttributionRpc,
  LAUNCH_ATTRIBUTION_LIMITS, type LaunchAttributionEvidence,
} from '../lib/server/launchAttribution'

const fixture = (name: string): LaunchAttributionEvidence => JSON.parse(readFileSync(new URL(`./fixtures/launch-attribution/${name}`, import.meta.url), 'utf8'))
const AERO = fixture('aero-base.json')
const DGUY = fixture('dguy-base.json')
const DGUY_CREATOR_TX_SENDER = '0x404a2e936be3c9faccb4a59c764c1d14f6add1af'
const DGUY_FACTORY = '0x4714f6ec81639ca59eebe634490a4d8671dce7b4'
const none = { address: null, methodUsed: null }

test('AERO: a direct CREATE is a verified creator with on-chain provenance', () => {
  const r = classifyLaunchAttribution(AERO, { address: '0xe83f922c34a1962e9ae9f52b59e18239764f2818', methodUsed: 'transaction_creation_record' })
  assert.equal(r.kind, 'direct_create')
  assert.deepEqual(r.verifiedCreator, { address: '0xe83f922c34a1962e9ae9f52b59e18239764f2818', confidence: 'high', provenance: ['creation_receipt', 'creation_transaction'] })
  assert.equal(r.launchInitiator, null)
  assert.equal(r.possibleDeveloperMatch, null)
  assert.equal(r.selectedDeployer.matches, 'verified_creator')
})

test('DGUY: factory launch gives a launch initiator and launchpad infrastructure, no developer match', () => {
  const r = classifyLaunchAttribution(DGUY, { address: DGUY_FACTORY, methodUsed: 'initial_mint_recipient' })
  assert.equal(r.kind, 'factory_create')
  assert.equal(r.verifiedCreator, null)
  assert.equal(r.launchInitiator?.address, DGUY_CREATOR_TX_SENDER)
  assert.equal(r.launchInitiator?.relayer, false)
  assert.deepEqual(r.launchpadInfrastructure, [{ address: DGUY_FACTORY, roles: ['transaction_target', 'mint_recipient'], provenance: ['bytecode_check'] }])
  // Sending the transaction and buying 1.58% in it is recorded, but is not enough to propose a developer.
  assert.equal(r.supportingSignals[0]?.signal, 'initiator_received_tokens_in_creation_tx')
  assert.equal(r.supportingSignals[0]?.shareOfMintedPct, 1.58)
  assert.equal(r.possibleDeveloperMatch, null)
  assert.ok(r.missingChecks.includes('launchpad_creator_event_not_reviewed'))
  assert.ok(r.missingChecks.includes('explorer_creation_record_unavailable'))
  assert.ok(r.missingChecks.includes('initiator_launch_history_unchecked'))
  assert.ok(r.uncertainty.includes('creation_proven_to_block_not_transaction'))
  // The existing selection is flagged, not changed.
  assert.deepEqual(r.selectedDeployer, { address: DGUY_FACTORY, methodUsed: 'initial_mint_recipient', matches: 'launchpad_infrastructure' })
})

test('DGUY: an independent explorer record naming the initiator gives a medium possible match only', () => {
  const r = classifyLaunchAttribution({ ...DGUY, explorerCreator: { address: DGUY_CREATOR_TX_SENDER, source: 'etherscan_v2_creation_record' } }, none)
  assert.deepEqual(r.possibleDeveloperMatch, { address: DGUY_CREATOR_TX_SENDER, confidence: 'medium', provenance: ['creation_transaction', 'explorer_creation_record'] })
  assert.equal(r.verifiedCreator, null, 'still not a verified creator')
})

test('an explorer record naming the factory is uncertainty, not a match', () => {
  const r = classifyLaunchAttribution({ ...DGUY, explorerCreator: { address: DGUY_FACTORY, source: 'etherscan_v2_creation_record' } }, none)
  assert.equal(r.possibleDeveloperMatch, null)
  assert.ok(r.uncertainty.includes('explorer_creator_is_launchpad_infrastructure'))
})

test('relayer: a launch sent through an ERC-4337 EntryPoint never proposes the bundler', () => {
  const entryPoint = '0x0000000071727de22e5e9d8baf0edac6f37da032'
  const r = classifyLaunchAttribution({
    ...DGUY,
    tx: { ...DGUY.tx!, to: entryPoint },
    codeAt: { ...DGUY.codeAt, [entryPoint]: '0x60806040' },
    explorerCreator: { address: DGUY_CREATOR_TX_SENDER, source: 'etherscan_v2_creation_record' },
  }, none)
  assert.equal(r.launchInitiator?.relayer, true)
  assert.deepEqual(r.launchInitiator?.provenance, ['creation_transaction', 'erc4337_entry_point'])
  assert.equal(r.possibleDeveloperMatch, null)
  assert.ok(r.uncertainty.includes('initiator_is_erc4337_bundler'))
})

test('factory contracts: an EOA mint recipient is not infrastructure; a recipient with code is', () => {
  const eoa = classifyLaunchAttribution({ ...DGUY, codeAt: { [DGUY_FACTORY]: '0x' } }, none)
  assert.deepEqual(eoa.launchpadInfrastructure, [])
  const unknown = classifyLaunchAttribution({ ...DGUY, codeAt: {} }, none)
  assert.deepEqual(unknown.launchpadInfrastructure, [])
  assert.ok(unknown.missingChecks.includes('bytecode_check_unavailable:transaction_target'))
})

test('a token that already existed before the block is not attributed from this transaction', () => {
  const r = classifyLaunchAttribution({ ...DGUY, tokenCodeBeforeBlock: '0x6080' }, { address: DGUY_FACTORY, methodUsed: 'initial_mint_recipient' })
  assert.equal(r.kind, 'not_creation_transaction')
  assert.equal(r.launchInitiator, null)
  assert.ok(r.uncertainty.includes('token_existed_before_block'))
})

test('missing evidence: no hash, unreadable transaction, no archive check → nothing proposed, reasons recorded', () => {
  const blank: LaunchAttributionEvidence = { token: DGUY.token, creationTxHash: null, tx: null, receipt: null, tokenCodeBeforeBlock: null, codeAt: {}, explorerCreator: null, failures: [] }
  const noHash = classifyLaunchAttribution(blank, { address: DGUY_FACTORY, methodUsed: 'initial_mint_recipient' })
  assert.equal(noHash.kind, 'unknown')
  assert.deepEqual(noHash.missingChecks, ['no_creation_or_first_mint_tx_hash'])
  assert.equal(noHash.selectedDeployer.matches, 'not_evaluated')
  const unreadable = classifyLaunchAttribution({ ...blank, creationTxHash: DGUY.creationTxHash, failures: ['transaction:rpc_http_429'] }, none)
  assert.deepEqual(unreadable.missingChecks, ['creation_transaction_unreadable'])
  assert.deepEqual(unreadable.uncertainty, ['transaction:rpc_http_429'])
  const noArchive = classifyLaunchAttribution({ ...DGUY, tokenCodeBeforeBlock: null }, none)
  assert.equal(noArchive.kind, 'unknown')
  assert.equal(noArchive.launchInitiator, null)
  assert.ok(noArchive.missingChecks.includes('archive_code_check_unavailable'))
})

function fixtureFetch(evidence: LaunchAttributionEvidence, sent: string[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body))
    sent.push(method)
    const result = method === 'eth_getTransactionByHash' ? { ...evidence.tx, blockNumber: `0x${evidence.tx!.blockNumber.toString(16)}` }
      : method === 'eth_getTransactionReceipt' ? evidence.receipt
        : method === 'eth_getCode' && params[1] !== 'latest' ? evidence.tokenCodeBeforeBlock
          : method === 'eth_getCode' ? (evidence.codeAt[params[0]] ?? '0x') : null
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
  }) as typeof fetch
}

test('collector: DGUY needs 4 read-only calls, AERO 2, inside the 5-call / 120-CU cap', async () => {
  for (const [evidence, expected] of [[DGUY, 4], [AERO, 2]] as const) {
    const sent: string[] = []
    const rpc = createLaunchAttributionRpc('https://rpc.test', fixtureFetch(evidence, sent))
    const collected = await collectLaunchAttributionEvidence(rpc, { token: evidence.token, creationTxHash: evidence.creationTxHash, explorerCreator: null })
    assert.equal(sent.length, expected)
    assert.ok(sent.every((m) => ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getCode'].includes(m)))
    assert.ok(rpc.budget.estimatedCuUsed() <= LAUNCH_ATTRIBUTION_LIMITS.maxEstimatedCu)
    assert.deepEqual(classifyLaunchAttribution(collected, none).kind, classifyLaunchAttribution(evidence, none).kind)
  }
})

test('collector: provider failures and a missing RPC become reasons, never a thrown scan', async () => {
  const failing = (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch
  const r = await buildLaunchAttributionShadow({ rpcUrl: 'https://rpc.test', token: DGUY.token, creationTxHash: DGUY.creationTxHash, explorerCreator: null, selected: { address: DGUY_FACTORY, methodUsed: 'initial_mint_recipient' }, fetchImpl: failing })
  assert.equal(r.kind, 'unknown')
  assert.deepEqual(r.uncertainty, ['transaction:rpc_http_429'])
  assert.equal(r.budget?.calls, 1)
  const unconfigured = await buildLaunchAttributionShadow({ rpcUrl: null, token: DGUY.token, creationTxHash: DGUY.creationTxHash, explorerCreator: null, selected: none })
  assert.equal(unconfigured.budget?.calls, 0)
  assert.equal(unconfigured.budget?.stoppedBy, 'rpc_unconfigured')
})

test('route: shadow runs only for debug scans and only reaches _debug diagnostics', () => {
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.match(route, /const launchAttributionShadow = debugMode === true && ethOriginDiscovery[\s\S]{0,80}\? \(async \(\) => \{/, 'started without awaiting')
  assert.match(route, /: Promise\.resolve\(null\)\n/, 'normal scans: no call at all')
  assert.equal(route.match(/launchAttributionShadow/g)?.length, 3, 'declared once, awaited once in devIntelDiagnostics')
  assert.match(route, /originDiscovery: ethOriginDiscovery\?\.diag \?\? null,\n\s+launchAttributionShadow: await launchAttributionShadow,/)
})
