// Launch attribution, SHADOW MODE: classifies who created a token from its creation transaction, keeping three
// identities apart — the verified creator, the launch initiator (the wallet that sent the launch transaction) and
// launchpad infrastructure (factory / proxy contracts). The result is diagnostics only: it never changes the
// selected deployer, dev clustering, supply control or CORTEX scoring. It runs only for debug scans.
//
// Evidence rules:
// - A verified creator needs on-chain proof: the creation receipt names the token as the created contract, so the
//   sender deployed it directly.
// - A factory launch (token created inside another contract) yields a launch initiator, never a developer: sending
//   the transaction or receiving tokens in it is not proof of authorship (bundlers, relayers and launchpad
//   operators do both).
// - A possible developer match needs independent evidence naming the initiator: an explorer creation record, or a
//   creator event from a reviewed launchpad (none reviewed yet, so that check is reported as missing).
import { createAlchemyCallBudget, type AlchemyCallBudget } from '@/lib/server/alchemyCallBudget'

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO = '0x0000000000000000000000000000000000000000'
const ADDRESS = /^0x[0-9a-f]{40}$/
const TX_HASH = /^0x[0-9a-f]{64}$/

// ERC-4337 EntryPoints (v0.6, v0.7, v0.8): a transaction sent to one comes from a bundler, not the launcher.
export const ERC4337_ENTRY_POINTS: ReadonlySet<string> = new Set([
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789',
  '0x0000000071727de22e5e9d8baf0edac6f37da032',
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108',
])

// Launchpads whose creator event has been reviewed and can be decoded. Empty until one is reviewed.
export const REVIEWED_LAUNCHPAD_CREATOR_EVENTS: ReadonlyMap<string, { topic0: string; creatorTopicIndex: number }> = new Map()

export const LAUNCH_ATTRIBUTION_LIMITS = { maxCalls: 5, maxEstimatedCu: 120, perCallTimeoutMs: 2_500, deadlineMs: 6_000 } as const

type Log = { address: string; topics: string[]; data: string }
export type LaunchAttributionEvidence = {
  token: string
  creationTxHash: string | null
  tx: { hash: string; from: string; to: string | null; blockNumber: number } | null
  receipt: { status: string; contractAddress: string | null; logs: Log[] } | null
  // eth_getCode(token, creationBlock - 1): '0x' proves the token did not exist before that block.
  tokenCodeBeforeBlock: string | null
  // eth_getCode(address, 'latest') for the transaction target and the first mint recipient.
  codeAt: Record<string, string | null>
  explorerCreator: { address: string; source: string } | null
  failures: string[]
}

export type Provenance = 'creation_receipt' | 'creation_transaction' | 'archive_code_check' | 'bytecode_check' | 'explorer_creation_record' | 'erc4337_entry_point' | 'reviewed_launchpad_event'
export type LaunchAttribution = {
  mode: 'shadow'
  kind: 'direct_create' | 'factory_create' | 'not_creation_transaction' | 'unknown'
  verifiedCreator: { address: string; confidence: 'high'; provenance: Provenance[] } | null
  launchInitiator: { address: string; relayer: boolean; provenance: Provenance[]; note: string } | null
  launchpadInfrastructure: Array<{ address: string; roles: Array<'transaction_target' | 'mint_recipient'>; provenance: Provenance[] }>
  possibleDeveloperMatch: { address: string; confidence: 'medium'; provenance: Provenance[] } | null
  supportingSignals: Array<{ signal: 'initiator_received_tokens_in_creation_tx'; shareOfMintedPct: number | null; note: string }>
  missingChecks: string[]
  uncertainty: string[]
  selectedDeployer: { address: string | null; methodUsed: string | null; matches: 'verified_creator' | 'launch_initiator' | 'launchpad_infrastructure' | 'none' | 'not_evaluated' }
  budget?: { calls: number; estimatedCu: number; ms: number; stoppedBy: string | null }
}

const low = (v: unknown): string | null => (typeof v === 'string' && ADDRESS.test(v.toLowerCase()) ? v.toLowerCase() : null)
const topicAddress = (t: string | undefined): string | null => (t && /^0x[0-9a-f]{64}$/i.test(t) ? `0x${t.slice(26).toLowerCase()}` : null)
const hasCode = (code: string | null | undefined): boolean | null => (code == null ? null : code !== '0x' && code !== '0x0')

export function classifyLaunchAttribution(evidence: LaunchAttributionEvidence, selected: { address: string | null; methodUsed: string | null }): LaunchAttribution {
  const token = evidence.token.toLowerCase()
  const out: LaunchAttribution = {
    mode: 'shadow', kind: 'unknown', verifiedCreator: null, launchInitiator: null, launchpadInfrastructure: [], possibleDeveloperMatch: null,
    supportingSignals: [], missingChecks: [], uncertainty: [...evidence.failures],
    selectedDeployer: { address: low(selected.address), methodUsed: selected.methodUsed, matches: 'not_evaluated' },
  }
  const finish = () => {
    const s = out.selectedDeployer.address
    if (s) {
      out.selectedDeployer.matches = out.verifiedCreator?.address === s ? 'verified_creator'
        : out.launchpadInfrastructure.some((i) => i.address === s) ? 'launchpad_infrastructure'
          : out.launchInitiator?.address === s ? 'launch_initiator'
            : out.kind === 'unknown' ? 'not_evaluated' : 'none'
    }
    return out
  }
  if (!evidence.creationTxHash) { out.missingChecks.push('no_creation_or_first_mint_tx_hash'); return finish() }
  if (!evidence.tx || !evidence.receipt) { out.missingChecks.push('creation_transaction_unreadable'); return finish() }
  if (evidence.receipt.status !== '0x1') { out.uncertainty.push('transaction_reverted'); return finish() }
  const from = low(evidence.tx.from)
  const to = low(evidence.tx.to)

  if (low(evidence.receipt.contractAddress) === token && from) {
    out.kind = 'direct_create'
    out.verifiedCreator = { address: from, confidence: 'high', provenance: ['creation_receipt', 'creation_transaction'] }
    return finish()
  }

  const transfers = evidence.receipt.logs.filter((l) => l.address.toLowerCase() === token && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC)
  const mints = transfers.filter((l) => topicAddress(l.topics[1]) === ZERO)
  if (mints.length === 0) { out.kind = 'not_creation_transaction'; out.uncertainty.push('no_mint_in_transaction'); return finish() }
  if (evidence.tokenCodeBeforeBlock == null) { out.missingChecks.push('archive_code_check_unavailable'); return finish() }
  if (hasCode(evidence.tokenCodeBeforeBlock)) { out.kind = 'not_creation_transaction'; out.uncertainty.push('token_existed_before_block'); return finish() }

  out.kind = 'factory_create'
  // The archive check proves creation in this block; the mint in this transaction ties it to this transaction
  // unless another transaction earlier in the same block created it without minting.
  out.uncertainty.push('creation_proven_to_block_not_transaction')
  const mintRecipient = topicAddress(mints[0].topics[2])
  for (const [address, role] of [[to, 'transaction_target'], [mintRecipient, 'mint_recipient']] as const) {
    if (!address || address === token) continue
    const known = out.launchpadInfrastructure.find((i) => i.address === address)
    if (known) { known.roles.push(role); continue }
    const code = hasCode(evidence.codeAt[address])
    if (code === true) out.launchpadInfrastructure.push({ address, roles: [role], provenance: ['bytecode_check'] })
    else if (code == null) out.missingChecks.push(`bytecode_check_unavailable:${role}`)
  }
  if (!from) return finish()
  const relayer = to != null && ERC4337_ENTRY_POINTS.has(to)
  out.launchInitiator = {
    address: from, relayer,
    provenance: relayer ? ['creation_transaction', 'erc4337_entry_point'] : ['creation_transaction'],
    note: relayer ? 'Bundler that relayed a user operation; the launching account is not the transaction sender.' : 'Sent the launch transaction. Not proof of authorship on its own.',
  }
  if (relayer) out.uncertainty.push('initiator_is_erc4337_bundler')

  const minted = mints.reduce((sum, l) => sum + safeBig(l.data), BigInt(0))
  const received = transfers.filter((l) => topicAddress(l.topics[2]) === from).reduce((sum, l) => sum + safeBig(l.data), BigInt(0))
  if (received > BigInt(0)) {
    out.supportingSignals.push({
      signal: 'initiator_received_tokens_in_creation_tx',
      shareOfMintedPct: minted > BigInt(0) ? Number(received * BigInt(10_000) / minted) / 100 : null,
      note: 'Supporting only: a buy in the launch transaction does not prove authorship.',
    })
  }

  const launchpad = out.launchpadInfrastructure.map((i) => i.address).find((a) => REVIEWED_LAUNCHPAD_CREATOR_EVENTS.has(a))
  if (!launchpad) out.missingChecks.push('launchpad_creator_event_not_reviewed')
  out.missingChecks.push('initiator_launch_history_unchecked')
  if (relayer) return finish()
  const provenance: Provenance[] = []
  if (launchpad) {
    const spec = REVIEWED_LAUNCHPAD_CREATOR_EVENTS.get(launchpad)!
    const event = evidence.receipt.logs.find((l) => l.address.toLowerCase() === launchpad && l.topics[0]?.toLowerCase() === spec.topic0)
    if (event && topicAddress(event.topics[spec.creatorTopicIndex]) === from) provenance.push('reviewed_launchpad_event')
  }
  const explorer = low(evidence.explorerCreator?.address)
  if (!evidence.explorerCreator) out.missingChecks.push('explorer_creation_record_unavailable')
  else if (explorer === from) provenance.push('explorer_creation_record')
  else if (explorer && out.launchpadInfrastructure.some((i) => i.address === explorer)) out.uncertainty.push('explorer_creator_is_launchpad_infrastructure')
  else out.uncertainty.push('explorer_creator_differs_from_initiator')
  if (provenance.length > 0) out.possibleDeveloperMatch = { address: from, confidence: 'medium', provenance: ['creation_transaction', ...provenance] }
  return finish()
}

function safeBig(data: string): bigint {
  try { return /^0x[0-9a-f]{1,64}$/i.test(data) ? BigInt(data) : BigInt(0) } catch { return BigInt(0) }
}

export type LaunchRpc = { budget: AlchemyCallBudget; call<T>(method: string, params: unknown[]): Promise<T> }

export function createLaunchAttributionRpc(url: string | null, fetchImpl: typeof fetch = fetch, now = Date.now): LaunchRpc & { stoppedBy(): string | null } {
  const budget = createAlchemyCallBudget({ maxCalls: LAUNCH_ATTRIBUTION_LIMITS.maxCalls, maxEstimatedCu: LAUNCH_ATTRIBUTION_LIMITS.maxEstimatedCu })
  const deadline = now() + LAUNCH_ATTRIBUTION_LIMITS.deadlineMs
  let stopped: string | null = null
  return {
    budget,
    stoppedBy: () => stopped,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (!url) throw new Error((stopped ??= 'rpc_unconfigured'))
      if (now() >= deadline) throw new Error((stopped ??= 'deadline'))
      const allowance = budget.check(method)
      if (!allowance.allowed) throw new Error((stopped ??= allowance.reason))
      budget.record(method)
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(Math.max(1, Math.min(LAUNCH_ATTRIBUTION_LIMITS.perCallTimeoutMs, deadline - now()))), cache: 'no-store' })
      if (!res.ok) throw new Error(`rpc_http_${res.status}`)
      const json = await res.json() as { result?: T; error?: unknown }
      if (json.error || json.result === undefined) throw new Error('rpc_error')
      return json.result
    },
  }
}

// At most 5 calls: transaction, receipt, archive code check, and bytecode of the target and mint recipient.
export async function collectLaunchAttributionEvidence(rpc: LaunchRpc, input: { token: string; creationTxHash: string | null; explorerCreator: { address: string; source: string } | null }): Promise<LaunchAttributionEvidence> {
  const evidence: LaunchAttributionEvidence = { token: input.token.toLowerCase(), creationTxHash: null, tx: null, receipt: null, tokenCodeBeforeBlock: null, codeAt: {}, explorerCreator: input.explorerCreator, failures: [] }
  const hash = typeof input.creationTxHash === 'string' && TX_HASH.test(input.creationTxHash.toLowerCase()) ? input.creationTxHash.toLowerCase() : null
  evidence.creationTxHash = hash
  if (!hash) return evidence
  const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
    try { return await run() } catch (e) { evidence.failures.push(`${label}:${e instanceof Error && /^[a-z0-9_]{1,48}$/.test(e.message) ? e.message : 'failed'}`); return null }
  }
  const tx = await attempt('transaction', () => rpc.call<{ hash: string; from: string; to: string | null; blockNumber: string }>('eth_getTransactionByHash', [hash]))
  if (!tx?.blockNumber) return evidence
  evidence.tx = { hash, from: tx.from, to: tx.to, blockNumber: parseInt(tx.blockNumber, 16) }
  const receipt = await attempt('receipt', () => rpc.call<{ status: string; contractAddress: string | null; logs: Log[] }>('eth_getTransactionReceipt', [hash]))
  if (!receipt) return evidence
  evidence.receipt = { status: receipt.status, contractAddress: receipt.contractAddress, logs: (receipt.logs ?? []).map((l) => ({ address: l.address, topics: l.topics ?? [], data: l.data ?? '0x' })) }
  if (low(receipt.contractAddress) === evidence.token || evidence.tx.blockNumber < 1) return evidence
  const mint = evidence.receipt.logs.find((l) => l.address.toLowerCase() === evidence.token && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC && topicAddress(l.topics[1]) === ZERO)
  if (!mint) return evidence
  evidence.tokenCodeBeforeBlock = await attempt('archive_code', () => rpc.call<string>('eth_getCode', [evidence.token, `0x${(evidence.tx!.blockNumber - 1).toString(16)}`]))
  if (evidence.tokenCodeBeforeBlock == null || hasCode(evidence.tokenCodeBeforeBlock)) return evidence
  for (const address of new Set([low(tx.to), topicAddress(mint.topics[2])])) {
    if (!address || address === evidence.token) continue
    evidence.codeAt[address] = await attempt('bytecode', () => rpc.call<string>('eth_getCode', [address, 'latest']))
  }
  return evidence
}

export async function buildLaunchAttributionShadow(input: { rpcUrl: string | null; token: string; creationTxHash: string | null; explorerCreator: { address: string; source: string } | null; selected: { address: string | null; methodUsed: string | null }; fetchImpl?: typeof fetch }): Promise<LaunchAttribution> {
  const started = Date.now()
  const rpc = createLaunchAttributionRpc(input.rpcUrl, input.fetchImpl)
  const evidence = await collectLaunchAttributionEvidence(rpc, input)
  const result = classifyLaunchAttribution(evidence, input.selected)
  result.budget = { calls: rpc.budget.callsUsed(), estimatedCu: rpc.budget.estimatedCuUsed(), ms: Date.now() - started, stoppedBy: rpc.stoppedBy() }
  return result
}
