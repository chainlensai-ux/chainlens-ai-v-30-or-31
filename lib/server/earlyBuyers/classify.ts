import type { BuyFact, BuyerGroup, DeliveryGraph, EarlyBuyer, EarlyBuyerIntel, SharedRecipient, Transfer } from './types'
import { rawPct } from './types'
import { KNOWN_DEX_ROUTER_ADDRESSES } from '../../../src/lib/knownDexRouters'

export const ZERO = '0x0000000000000000000000000000000000000000'
export const DEAD = '0x000000000000000000000000000000000000dead'
const ADDRESS = /^0x[0-9a-f]{40}$/i

// Existing public infrastructure. Unknown contracts are never silently treated as private proof:
// T2 is an association only, and the caller may add scan-specific routers/escrows.
export const PUBLIC_CALL_TARGETS = new Set([
  ...KNOWN_DEX_ROUTER_ADDRESSES,
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', // ERC-4337 EntryPoint v0.6
  '0x0000000071727de22e5e9d8baf0edac6f37da032', // ERC-4337 EntryPoint v0.7
].map((address) => address.toLowerCase()))
const ENTRYPOINTS = new Set(['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', '0x0000000071727de22e5e9d8baf0edac6f37da032'])

export function isAddress(value: unknown): value is string { return typeof value === 'string' && ADDRESS.test(value) }
const normal = (value: string) => value.toLowerCase()

/** Follow only token transfers connected to a swap's verified pool/manager source. */
export function deriveBuyFacts(input: {
  transfers: Transfer[]
  poolSources: ReadonlySet<string>
  infrastructure: ReadonlySet<string>
  signer: string
  called: string | null
  txHash: string
  block: number
  transactionIndex: number
  pool?: string
  timestampSec?: number | null
}): BuyFact[] {
  const sources = new Set([...input.poolSources].map(normal))
  const infra = new Set([ZERO, DEAD, ...input.infrastructure, ...(isAddress(input.called) ? [input.called] : [])].map(normal))
  // Only pool-origin quantity can propagate through receipt-order transfers. A router's own
  // pre-existing balance cannot be attributed to this launch swap merely because it also
  // received a small amount from the pool in the same transaction.
  const sourcedBalance = new Map<string, bigint>()
  const net = new Map<string, bigint>()
  for (const t of input.transfers) {
    if (t.rawAmount <= BigInt(0)) continue
    const from = normal(t.from), to = normal(t.to)
    const available = sources.has(from) ? t.rawAmount : sourcedBalance.get(from) ?? BigInt(0)
    const attributed = available < t.rawAmount ? available : t.rawAmount
    if (attributed <= BigInt(0)) continue
    if (!sources.has(from)) sourcedBalance.set(from, available - attributed)
    sourcedBalance.set(to, (sourcedBalance.get(to) ?? BigInt(0)) + attributed)
    if (!infra.has(to) && isAddress(to)) net.set(to, (net.get(to) ?? BigInt(0)) + attributed)
    if (!infra.has(from) && !sources.has(from)) net.set(from, (net.get(from) ?? BigInt(0)) - attributed)
  }
  return [...net].filter(([wallet, rawAmount]) => rawAmount > BigInt(0) && !infra.has(wallet))
    .map(([wallet, rawAmount]) => ({ wallet, rawAmount, txHash: input.txHash.toLowerCase(), block: input.block, signer: normal(input.signer), called: input.called?.toLowerCase() ?? null, transactionIndex: input.transactionIndex, pool: input.pool?.toLowerCase(), timestampSec: input.timestampSec ?? null }))
}

// Shared-recipient thresholds. A wallet is set aside from T1 linking only when it co-received in at
// least SHARED_MIN_TRANSACTIONS multi-recipient transactions AND its partners in those transactions
// form at least SHARED_MIN_PARTNER_CLUSTERS clusters that share no wallet. A bot that repeatedly
// delivers to the same wallets forms one cluster and keeps its T1 link.
export const SHARED_MIN_TRANSACTIONS = 3
export const SHARED_MIN_PARTNER_CLUSTERS = 3
// Fee/distribution pattern: a minority share at or below 25% of each transaction's pool-sourced
// deliveries, varying by at most 1 percentage point, across at least 3 distinct signers.
export const FEE_PATTERN_MAX_SHARE_BPS = 2500
export const FEE_PATTERN_MAX_SPREAD_BPS = 100
export const FEE_PATTERN_MIN_SIGNERS = 3

const SHARED_T1_REASON = 'One transaction delivered pool-sourced tokens to multiple recipients; payment or common ownership is not proven'

/** One multi-recipient transaction. Amounts and signer are null when rebuilt from a stored row. */
export type SharedDeliveryTx = { txHash: string; signer: string | null; amounts: Map<string, bigint | null> }

function unionFind() {
  const parent = new Map<string, string>()
  const root = (w: string): string => { let r = w; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; let c = w; while (c !== r) { const n = parent.get(c) ?? r; parent.set(c, r); c = n } return r }
  // Deterministic: the lexicographically smaller root wins.
  const union = (a: string, b: string) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); const ra = root(a), rb = root(b); if (ra !== rb) { if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb) } }
  return { root: (w: string) => (parent.has(w) ? root(w) : w), union }
}

/**
 * Builds T1 groups from direct shared-transaction deliveries without letting a high-frequency
 * shared recipient bridge otherwise unrelated recipients. Pure and order-independent.
 */
export function buildSharedDeliveryGraph(txs: SharedDeliveryTx[], buyers: Array<Pick<EarlyBuyer, 'wallet' | 'boughtRaw'>>, source: DeliveryGraph['source']): { groups: BuyerGroup[]; graph: DeliveryGraph } {
  const multi = txs.map((t) => ({ ...t, wallets: [...t.amounts.keys()].map(normal).sort() })).filter((t) => t.wallets.length > 1).sort((a, b) => a.txHash.localeCompare(b.txHash))
  const byWallet = new Map<string, typeof multi>()
  for (const t of multi) for (const w of t.wallets) { const rows = byWallet.get(w) ?? []; rows.push(t); byWallet.set(w, rows) }
  const shared = new Map<string, SharedRecipient>()
  for (const [wallet, rows] of byWallet) {
    if (rows.length < SHARED_MIN_TRANSACTIONS) continue
    // Partner clusters: the other recipients of each of this wallet's transactions, joined when two
    // transactions share a partner. Only this wallet's own transactions are considered.
    const uf = unionFind()
    for (const t of rows) { const partners = t.wallets.filter((w) => w !== wallet); for (const p of partners.slice(1)) uf.union(partners[0], p) }
    const clusters = new Set(rows.map((t) => uf.root(t.wallets.find((w) => w !== wallet)!))).size
    if (clusters < SHARED_MIN_PARTNER_CLUSTERS) continue
    const signerSet = rows.every((t) => t.signer != null) ? new Set(rows.map((t) => normal(t.signer!))) : null
    let shareBps: SharedRecipient['shareBps'] = null
    if (rows.every((t) => [...t.amounts.values()].every((v) => v != null))) {
      const shares = rows.map((t) => { const total = [...t.amounts.values()].reduce<bigint>((sum, v) => sum + v!, BigInt(0)); const own = t.amounts.get(wallet) ?? BigInt(0); return total > BigInt(0) ? Number(own * BigInt(10000) / total) : 10000 })
      shareBps = { min: Math.min(...shares), max: Math.max(...shares) }
    }
    const feePattern = shareBps != null && signerSet != null && signerSet.size >= FEE_PATTERN_MIN_SIGNERS && shareBps.max <= FEE_PATTERN_MAX_SHARE_BPS && shareBps.max - shareBps.min <= FEE_PATTERN_MAX_SPREAD_BPS
    shared.set(wallet, {
      wallet,
      classification: feePattern ? 'fee_or_distribution_pattern' : 'high_frequency_shared_recipient',
      transactions: rows.map((t) => t.txHash),
      partnerClusters: clusters,
      signers: signerSet?.size ?? null,
      shareBps,
      reason: feePattern
        ? `Received a near-constant ${(shareBps!.min / 100).toFixed(2)}–${(shareBps!.max / 100).toFixed(2)}% of the pool-sourced delivery in ${rows.length} transactions from ${signerSet!.size} signers alongside ${clusters} unconnected recipient clusters; consistent with a percentage fee or distribution. Ownership and purpose are not proven`
        : `Co-received in ${rows.length} multi-recipient transactions alongside ${clusters} unconnected recipient clusters; not used to link those recipients. Purpose and ownership are not proven`,
    })
  }
  const uf = unionFind()
  const links: Array<{ txHash: string; wallets: string[] }> = []
  for (const t of multi) {
    const ordinary = t.wallets.filter((w) => !shared.has(w))
    if (ordinary.length < 2) continue
    links.push({ txHash: t.txHash, wallets: ordinary })
    for (const w of ordinary.slice(1)) uf.union(ordinary[0], w)
  }
  const components = new Map<string, Set<string>>()
  for (const l of links) for (const w of l.wallets) { const r = uf.root(w); const set = components.get(r) ?? new Set<string>(); set.add(w); components.set(r, set) }
  const bought = new Map(buyers.map((b) => [normal(b.wallet), BigInt(b.boughtRaw)]))
  const observedTotal = [...bought.values()].reduce((sum, v) => sum + v, BigInt(0))
  const ordinaryTotal = [...bought].filter(([w]) => !shared.has(w)).reduce((sum, [, v]) => sum + v, BigInt(0))
  const groups: BuyerGroup[] = [...components.values()].filter((set) => set.size > 1).map((set) => {
    const wallets = [...set].sort()
    const sum = wallets.reduce((acc, w) => acc + (bought.get(w) ?? BigInt(0)), BigInt(0))
    return { tier: 'T1' as const, associationType: 'shared_transaction_delivery' as const, wallets, transactions: links.filter((l) => set.has(l.wallets[0])).map((l) => l.txHash), reason: SHARED_T1_REASON, boughtWithinEarlySetPct: rawPct(sum, observedTotal), boughtWithinOrdinaryRecipientsPct: rawPct(sum, ordinaryTotal), heldWithinEarlySetPct: null }
  }).sort((a, b) => a.wallets[0].localeCompare(b.wallets[0]))
  const linked = new Set(groups.flatMap((g) => g.wallets))
  const ordinaryRecipients = [...bought.keys()].filter((w) => !shared.has(w))
  return { groups, graph: {
    source,
    multiRecipientTransactions: multi.length,
    linkingTransactions: links.length,
    sharedRecipients: [...shared.values()].sort((a, b) => a.wallet.localeCompare(b.wallet)),
    unlinkedRecipients: ordinaryRecipients.filter((w) => !linked.has(w)).length,
    denominators: { observedRecipients: bought.size, observedDeliveredRaw: observedTotal.toString(), ordinaryRecipients: ordinaryRecipients.length, ordinaryDeliveredRaw: ordinaryTotal.toString() },
  } }
}

export function classifyEarlyBuyers(facts: BuyFact[], verifiedLaunch: boolean, excludedCallTargets: ReadonlySet<string> = PUBLIC_CALL_TARGETS): {
  buyers: EarlyBuyer[]; groups: BuyerGroup[]; sameBlockCount: number; deliveryGraph?: DeliveryGraph
} {
  const byWallet = new Map<string, { raw: bigint; txs: Set<string>; blocks: Set<number>; facts: BuyFact[] }>()
  for (const f of facts) {
    const wallet = normal(f.wallet)
    const row = byWallet.get(wallet) ?? { raw: BigInt(0), txs: new Set<string>(), blocks: new Set<number>(), facts: [] }
    row.raw += f.rawAmount; row.txs.add(f.txHash); row.blocks.add(f.block); row.facts.push(f); byWallet.set(wallet, row)
  }
  const buyers: EarlyBuyer[] = [...byWallet].sort(([a], [b]) => a.localeCompare(b)).map(([wallet, row]) => ({ wallet, purchaseProven: false, boughtRaw: row.raw.toString(), heldRaw: null, transactions: [...row.txs].sort(), blocks: [...row.blocks].sort((a, b) => a - b), evidence: row.facts.filter((f) => f.pool).map((f) => ({ txHash: f.txHash, pool: f.pool!, block: f.block, timestampSec: f.timestampSec ?? null, reason: 'pool_sourced_token_delivery_in_swap_transaction' as const })) }))
  const byBlock = new Map<number, Set<string>>()
  for (const f of facts) { const s = byBlock.get(f.block) ?? new Set<string>(); s.add(normal(f.wallet)); byBlock.set(f.block, s) }
  const sameBlockCount = new Set([...byBlock.values()].filter((s) => s.size > 1).flatMap((s) => [...s])).size
  if (!verifiedLaunch) return { buyers, groups: [], sameBlockCount }

  const byTx = new Map<string, BuyFact[]>()
  for (const f of facts) { const tx = byTx.get(f.txHash) ?? []; tx.push(f); byTx.set(f.txHash, tx) }
  // ERC-4337 bundles carry unrelated user operations; they never form a shared delivery.
  const sharedTxs: SharedDeliveryTx[] = [...byTx].filter(([, rows]) => !rows.some((r) => r.called && ENTRYPOINTS.has(r.called.toLowerCase()))).map(([txHash, rows]) => {
    const amounts = new Map<string, bigint | null>()
    for (const r of rows) amounts.set(normal(r.wallet), (amounts.get(normal(r.wallet)) ?? BigInt(0)) + r.rawAmount)
    return { txHash, signer: rows[0].signer, amounts }
  })
  const { groups, graph } = buildSharedDeliveryGraph(sharedTxs, buyers, 'transaction_facts')
  const sharedWallets = new Set(graph.sharedRecipients.map((r) => r.wallet))
  // T2 never includes a shared recipient: its presence in many transactions is what set it aside.
  const bySigner = new Map<string, BuyFact[]>()
  for (const f of facts) {
    if (sharedWallets.has(normal(f.wallet))) continue
    // ERC-4337 bundles are paid by a public bundler; never infer ownership from that signer.
    if (f.called && ENTRYPOINTS.has(f.called.toLowerCase())) continue
    const signer = bySigner.get(f.signer) ?? []; signer.push(f); bySigner.set(f.signer, signer)
  }
  // The signer is the transaction initiator (and normally the EVM gas payer), not proof that
  // each distinct recipient purchased tokens or belongs to that signer. Keep it associative.
  for (const rows of bySigner.values()) {
    const wallets = [...new Set(rows.map((r) => normal(r.wallet)))].sort()
    const transactions = [...new Set(rows.map((r) => r.txHash))].sort()
    if (wallets.length > 1 && transactions.length > 1 && !groups.some((g) => g.tier === 'T1' && wallets.every((w) => g.wallets.includes(w)))) {
      groups.push({ tier: 'T2', associationType: 'common_initiator', wallets, transactions, reason: 'The same transaction signer initiated separate token deliveries; purchase funding, coordination, and common ownership are not proven', boughtWithinEarlySetPct: null, heldWithinEarlySetPct: null })
    }
  }
  // Same block + same non-public call target is an association, never a bundle or owner claim.
  const associations = new Map<string, BuyFact[]>()
  for (const f of facts) {
    if (!f.called || excludedCallTargets.has(f.called.toLowerCase()) || sharedWallets.has(normal(f.wallet))) continue
    const key = `${f.block}:${f.called.toLowerCase()}`
    const rows = associations.get(key) ?? []; rows.push(f); associations.set(key, rows)
  }
  for (const [key, rows] of associations) {
    const wallets = [...new Set(rows.map((r) => normal(r.wallet)))].sort()
    if (wallets.length < 2 || groups.some((g) => g.tier === 'T1' && wallets.every((w) => g.wallets.includes(w)))) continue
    groups.push({ tier: 'T2', associationType: 'shared_contract_call', wallets, transactions: [...new Set(rows.map((r) => r.txHash))].sort(), reason: `Same block and contract ${key.split(':')[1]}; timing association, not proof of control`, boughtWithinEarlySetPct: null, heldWithinEarlySetPct: null })
  }
  return { buyers, groups, sameBlockCount, deliveryGraph: graph }
}

/**
 * Stored rows written before the shared-recipient rule carry T1 groups built by plain transitive
 * merging. Rebuild T1 from the transactions those groups already cite (which excluded ERC-4337
 * bundles). Stored rows keep no per-transaction amounts or signers, so a shared recipient can only
 * be a candidate here, never a fee/distribution pattern.
 */
export function upgradeLegacyDeliveryGraph(intel: EarlyBuyerIntel): EarlyBuyerIntel {
  if (intel.deliveryGraph || !intel.groups.some((g) => g.tier === 'T1')) return intel
  const cited = new Set(intel.groups.filter((g) => g.tier === 'T1').flatMap((g) => g.transactions.map((h) => h.toLowerCase())))
  const txs = new Map<string, SharedDeliveryTx>()
  for (const b of intel.buyers) for (const h of b.transactions) {
    const hash = h.toLowerCase()
    if (!cited.has(hash)) continue
    const row = txs.get(hash) ?? { txHash: hash, signer: null, amounts: new Map<string, bigint | null>() }
    row.amounts.set(normal(b.wallet), null); txs.set(hash, row)
  }
  const { groups, graph } = buildSharedDeliveryGraph([...txs.values()], intel.buyers, 'legacy_rebuild')
  const sharedWallets = new Set(graph.sharedRecipients.map((r) => r.wallet))
  const t2 = intel.groups.filter((g) => g.tier === 'T2').map((g) => ({ ...g, wallets: g.wallets.filter((w) => !sharedWallets.has(normal(w))) })).filter((g) => g.wallets.length > 1)
  return { ...intel, groups: [...groups, ...t2], deliveryGraph: graph }
}
