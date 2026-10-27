import type { BuyFact, BuyerGroup, EarlyBuyer, Transfer } from './types'
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

export function classifyEarlyBuyers(facts: BuyFact[], verifiedLaunch: boolean, excludedCallTargets: ReadonlySet<string> = PUBLIC_CALL_TARGETS): {
  buyers: EarlyBuyer[]; groups: BuyerGroup[]; sameBlockCount: number
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

  const t1Edges: Array<{ wallets: string[]; txHash: string; reason: string }> = []
  const byTx = new Map<string, BuyFact[]>()
  const bySigner = new Map<string, BuyFact[]>()
  for (const f of facts) {
    const tx = byTx.get(f.txHash) ?? []; tx.push(f); byTx.set(f.txHash, tx)
    // ERC-4337 bundles are paid by a public bundler; never infer ownership from that signer.
    if (f.called && ENTRYPOINTS.has(f.called.toLowerCase())) continue
    const signer = bySigner.get(f.signer) ?? []; signer.push(f); bySigner.set(f.signer, signer)
  }
  for (const [txHash, rows] of byTx) {
    const wallets = [...new Set(rows.map((r) => normal(r.wallet)))].sort()
    if (wallets.length > 1 && !rows.some((r) => r.called && ENTRYPOINTS.has(r.called.toLowerCase()))) t1Edges.push({ wallets, txHash, reason: 'One transaction delivered pool-sourced tokens to multiple recipients; payment or common ownership is not proven' })
  }
  const parent = new Map(buyers.map((b) => [b.wallet, b.wallet]))
  const root = (w: string): string => { let p = parent.get(w) ?? w; while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p; return p }
  for (const e of t1Edges) for (const w of e.wallets.slice(1)) parent.set(root(w), root(e.wallets[0]))
  const components = new Map<string, Set<string>>()
  for (const b of buyers) { const r = root(b.wallet); const s = components.get(r) ?? new Set<string>(); s.add(b.wallet); components.set(r, s) }
  const groups: BuyerGroup[] = []
  const totalBought = buyers.reduce((sum, b) => sum + BigInt(b.boughtRaw), BigInt(0))
  for (const wallets of components.values()) {
    if (wallets.size < 2) continue
    const edges = t1Edges.filter((e) => e.wallets.some((w) => wallets.has(w)))
    const bought = buyers.filter((b) => wallets.has(b.wallet)).reduce((sum, b) => sum + BigInt(b.boughtRaw), BigInt(0))
    groups.push({ tier: 'T1', associationType: 'shared_transaction_delivery', wallets: [...wallets].sort(), transactions: [...new Set(edges.map((e) => e.txHash))].sort(), reason: [...new Set(edges.map((e) => e.reason))].join('; '), boughtWithinEarlySetPct: totalBought > BigInt(0) ? Number(bought * BigInt(10000) / totalBought) / 100 : null, heldWithinEarlySetPct: null })
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
    if (!f.called || excludedCallTargets.has(f.called.toLowerCase())) continue
    const key = `${f.block}:${f.called.toLowerCase()}`
    const rows = associations.get(key) ?? []; rows.push(f); associations.set(key, rows)
  }
  for (const [key, rows] of associations) {
    const wallets = [...new Set(rows.map((r) => normal(r.wallet)))].sort()
    if (wallets.length < 2 || groups.some((g) => g.tier === 'T1' && wallets.every((w) => g.wallets.includes(w)))) continue
    groups.push({ tier: 'T2', associationType: 'shared_contract_call', wallets, transactions: [...new Set(rows.map((r) => r.txHash))].sort(), reason: `Same block and contract ${key.split(':')[1]}; timing association, not proof of control`, boughtWithinEarlySetPct: null, heldWithinEarlySetPct: null })
  }
  return { buyers, groups, sameBlockCount }
}
