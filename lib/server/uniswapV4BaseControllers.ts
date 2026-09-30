// lib/server/uniswapV4BaseControllers.ts — who actually MODIFIES liquidity in a Base Uniswap V4 pool when
// that activity does not go through the canonical PositionManager NFT path. Classifies each direct
// ModifyLiquidity caller (`sender`) and, where evidence allows, the control path behind it — never
// invents beneficial ownership:
//  - the sender of a PoolManager ModifyLiquidity event is the contract/account that called
//    modifyLiquidity inside an unlock callback. It is the DIRECT modifier of that activity, not proof of
//    who owns the pool's liquidity;
//  - an EOA sender (no code) directly controls the liquidity activity it submitted — reported as a
//    direct controller of observed activity, never as the owner of all pool liquidity;
//  - a known router / periphery contract is an INTERMEDIARY only — never a controller;
//  - the pool's own hook (PoolKey.hooks, proven from the Initialize event hashing back to the PoolId)
//    is classified as a hook — never an owner unless custody is separately proven (not attempted here);
//  - an unknown contract gets ONLY control reads its bytecode advertises (PUSH4 selector present) or a
//    proven Safe-style proxy interface; a returned owner/admin is "contract controlled by X", never
//    "X owns the LP".
// Activity share (events / net observed delta) is LIQUIDITY ACTIVITY concentration, never ownership share.
//
// REGISTRY SOURCES (no address from memory):
//  - Uniswap's official Base deployment metadata, github.com/Uniswap/contracts deployments/8453.md
//    (raw main, fetched 2026-09-30): UniversalRouter v1.2/v2.0/v2.1/v2.1.2/v2.2, SwapRouter02,
//    UniswapV2Router02, V3Migrator, V4Quoter, Permit2, PositionManager, PermissionedPositionManager,
//    PermissionedHooks, WETHHook;
//  - src/lib/knownDexRouters.ts (the repo's verified shared router registry);
//  - lib/server/lpLockBurnIntel.ts LP_LOCK_BURN_REGISTRY.lockersByChain.base (currently empty).
//
// COST: reuses the ModifyLiquidity events the position index already paged (no second log scan).
// <= V4_CONTROLLER_MAX_CODE_READS eth_getCode (top unregistered senders by event count), ONE Multicall3
// aggregate3 for every gated control read, <= V4_CONTROLLER_MAX_OWNER_CODE_READS eth_getCode for the
// resolved owners/admins: hard ceiling V4_CONTROLLER_MAX_REQUESTS network requests. Multicall3 failure
// has no fallback fan-out (control stays unverified).

import { knownDexRouterProtocol } from '../../src/lib/knownDexRouters.ts'
import { LP_LOCK_BURN_REGISTRY } from './lpLockBurnIntel.ts'
import { MULTICALL3_ADDRESS, decodeAggregate3, encodeAggregate3, type Multicall3SubCall } from './multicall3.ts'

export const BASE_V4_CANONICAL_POSITION_MANAGER = '0x7c5f5a4bbd8fd63184577525326123b519429bdc'
export const BASE_UNISWAP_DEPLOYMENTS_EVIDENCE = 'github.com/Uniswap/contracts deployments/8453.md (official Base deployment metadata)'

type RegistryEntry = { type: 'position_manager' | 'router' | 'hook'; label: string }
/** Official Uniswap Base deployments (deployments/8453.md). Lowercase. */
export const BASE_UNISWAP_OFFICIAL_CONTRACTS: Readonly<Record<string, RegistryEntry>> = {
  [BASE_V4_CANONICAL_POSITION_MANAGER]: { type: 'position_manager', label: 'Uniswap V4 PositionManager' },
  '0xc09255d86db563cbc11c2fcf4a0c512e160111b4': { type: 'position_manager', label: 'Uniswap V4 PermissionedPositionManager' },
  '0xbe2257d1aafbe6b73f67a9ac971c2f0b344bb3c5': { type: 'router', label: 'Uniswap UniversalRouter v2.2' },
  '0xf3a4f4094bd2c6c06ca2f61789d8727b8d1e7259': { type: 'router', label: 'Uniswap UniversalRouter v2.1' },
  '0x6ff5693b99212da76ad316178a184ab56d299b43': { type: 'router', label: 'Uniswap UniversalRouter v2.0' },
  '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40': { type: 'router', label: 'Uniswap UniversalRouter v2.1.2' },
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': { type: 'router', label: 'Uniswap UniversalRouter v1.2' },
  '0x2626664c2603336e57b271c5c0b26f421741e481': { type: 'router', label: 'Uniswap SwapRouter02' },
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24': { type: 'router', label: 'Uniswap V2 Router02' },
  '0x23cf10b1ee3adfca73b0ef17c07f7577e7acd2d7': { type: 'router', label: 'Uniswap V3Migrator' },
  '0x0d5e0f971ed27fbff6c2837bf31316121532048d': { type: 'router', label: 'Uniswap V4Quoter' },
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { type: 'router', label: 'Permit2' },
  '0x5750be78fedfb2fa48faa6c6623400ba4538a8c0': { type: 'hook', label: 'Uniswap PermissionedHooks' },
  '0xb08211d57032dd10b1974d4b876851a7f7596888': { type: 'hook', label: 'Uniswap WETHHook' },
}

export const SEL_OWNER = '0x8da5cb5b' // owner()
export const SEL_GET_OWNER = '0x893d20e8' // getOwner()
export const SEL_ADMIN = '0xf851a440' // admin()
export const SEL_GET_OWNERS = '0xa0e67e2b' // getOwners()        (Safe)
export const SEL_GET_THRESHOLD = '0xe75235b8' // getThreshold()  (Safe)
export const SEL_MASTER_COPY = '0xa619486e' // masterCopy()       (Safe proxy fallback dispatch)

export const V4_CONTROLLER_MAX_CODE_READS = 5
export const V4_CONTROLLER_MAX_OWNER_CODE_READS = 2
export const V4_CONTROLLER_MAX_SUBCALLS = 20
export const V4_CONTROLLER_MAX_REQUESTS = V4_CONTROLLER_MAX_CODE_READS + 1 + V4_CONTROLLER_MAX_OWNER_CODE_READS
const CODE_TTL_MS = 60 * 60_000
const CONTROL_TTL_MS = 10 * 60_000
const CACHE_MAX = 1000
const ZERO = '0x0000000000000000000000000000000000000000'

export type V4ControllerType = 'eoa' | 'position_manager' | 'router' | 'vault' | 'locker' | 'hook' | 'smart_wallet' | 'multisig' | 'contract' | 'unknown'
export type V4ControllerEvidence = 'direct_modify_liquidity' | 'verified_contract_identity' | 'verified_owner_read' | 'verified_beneficiary_read' | 'verified_admin_read' | 'known_protocol_registry' | 'pool_key_hook'
export type V4ControllerRole = 'direct_controller' | 'contract_controlled' | 'intermediary' | 'hook' | 'unverified'

export type V4ControllerRow = {
  address: string
  type: V4ControllerType
  role: V4ControllerRole
  evidence: V4ControllerEvidence[]
  label: string | null
  activityCount: number
  addEvents: number
  removeEvents: number
  netLiquidityRaw: string
  /** Share of all observed ModifyLiquidity events for this pool — ACTIVITY, not ownership. */
  shareOfObservedActivity: number | null
  sampleTxs: string[]
  controllerAddress: string | null
  controllerType: 'eoa' | 'smart_wallet' | 'contract' | 'unknown' | null
  controllerSource: 'owner' | 'getOwner' | 'admin' | 'safe_owners' | null
  safe: { owners: string[]; threshold: number } | null
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export type V4ControllerAttribution = {
  status: 'verified' | 'partial' | 'unavailable_with_reason'
  publicText: string
  /** One-line "Liquidity Controller" summary for the UI (types of direct modifiers). */
  controllerSummary: string
  controllers: V4ControllerRow[]
  hook: { address: string; label: string | null; isModifier: boolean } | null
  totalObservedEvents: number
  positionManagerEvents: number
  nonPositionManagerEvents: number
  unattributedEvents: number
  concentration: {
    label: 'Liquidity activity concentration'
    uniqueModifiers: number
    eoaModifiers: number
    contractModifiers: number
    intermediaryModifiers: number
    topModifier: string | null
    topModifierEventSharePct: number | null
    topModifierNetAddSharePct: number | null
    text: string | null
  }
  coverage: { reachedPoolCreation: boolean; classified: number; unclassified: number; codeReads: number; controlReads: number; multicallFailed: boolean; deadlineHit: boolean }
  requests: { network: number; codeReads: number; multicallBatches: number; multicallSubcalls: number; ownerCodeReads: number }
}

export type SenderStats = { events: number; net: bigint; adds: number; removes: number; lastBlock: number; txs: string[] }
export type ControllerRpc = (method: string, params: unknown[], timeoutMs: number) => Promise<{ result: unknown; error: string | null }>

type CodeInfo = { kind: 'eoa' | 'eip7702' | 'contract'; hasOwner: boolean; hasGetOwner: boolean; hasAdmin: boolean; safeLike: boolean; delegate: string | null }
type ControlRead = { controller: string | null; source: V4ControllerRow['controllerSource']; safe: { owners: string[]; threshold: number } | null }

const codeCache = new Map<string, { expiresAt: number; info: CodeInfo }>()
const controlCache = new Map<string, { expiresAt: number; value: ControlRead }>()
export function resetV4ControllerCache() { codeCache.clear(); controlCache.clear() }
const bounded = <K, V>(m: Map<K, V>) => { if (m.size >= CACHE_MAX) m.delete(m.keys().next().value!) }
const key = (a: string) => `base:${a}`

/** Classifies raw runtime bytecode. EIP-7702 delegation designator = 0xef0100 || address. Exported for tests. */
export function classifyCode(code: unknown): CodeInfo | null {
  if (typeof code !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(code)) return null
  const b = code.slice(2).toLowerCase()
  if (b.length === 0) return { kind: 'eoa', hasOwner: false, hasGetOwner: false, hasAdmin: false, safeLike: false, delegate: null }
  if (/^ef0100[0-9a-f]{40}$/.test(b)) return { kind: 'eip7702', hasOwner: false, hasGetOwner: false, hasAdmin: false, safeLike: false, delegate: `0x${b.slice(6)}` }
  const push4 = (sel: string) => b.includes(`63${sel.slice(2)}`)
  // Safe proxy: dispatches masterCopy() by comparing calldata against the selector as a PUSH32 word.
  const safeProxy = b.includes(`7f${SEL_MASTER_COPY.slice(2)}${'0'.repeat(56)}`)
  const safeSingleton = push4(SEL_GET_OWNERS) && push4(SEL_GET_THRESHOLD)
  return { kind: 'contract', hasOwner: push4(SEL_OWNER), hasGetOwner: push4(SEL_GET_OWNER), hasAdmin: push4(SEL_ADMIN), safeLike: safeProxy || safeSingleton, delegate: null }
}

/** One ABI address word (zero-padded), else null. */
export function decodeAddressWord(hex: string): string | null {
  const b = hex.replace(/^0x/, '').toLowerCase()
  return /^0{24}[0-9a-f]{40}$/.test(b) ? `0x${b.slice(24)}` : null
}
/** Safe getOwners(): address[] (offset 0x20, length n, n address words), 1..50 non-zero owners. */
export function decodeAddressArray(hex: string): string[] | null {
  const b = hex.replace(/^0x/, '').toLowerCase()
  if (b.length < 128 || b.length % 64 !== 0 || !/^[0-9a-f]+$/.test(b)) return null
  if (BigInt(`0x${b.slice(0, 64)}`) !== BigInt(32)) return null
  const n = Number(BigInt(`0x${b.slice(64, 128)}`))
  if (!Number.isInteger(n) || n < 1 || n > 50 || b.length !== 128 + n * 64) return null
  const out: string[] = []
  for (let i = 0; i < n; i++) { const a = decodeAddressWord(b.slice(128 + i * 64, 192 + i * 64)); if (!a || a === ZERO) return null; out.push(a) }
  return out
}
const decodeSmallUint = (hex: string): number | null => {
  const b = hex.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{64}$/.test(b)) return null
  const v = BigInt(`0x${b}`)
  return v <= BigInt(1000) ? Number(v) : null
}

function registryIdentity(address: string, hook: string | null): { type: V4ControllerType; label: string; evidence: V4ControllerEvidence } | null {
  const official = BASE_UNISWAP_OFFICIAL_CONTRACTS[address]
  if (official) return { type: official.type, label: official.label, evidence: 'known_protocol_registry' }
  if (hook && address === hook) return { type: 'hook', label: 'Pool hook contract', evidence: 'pool_key_hook' }
  const router = knownDexRouterProtocol(address)
  if (router) return { type: 'router', label: `Known router (${router})`, evidence: 'known_protocol_registry' }
  if ((LP_LOCK_BURN_REGISTRY.lockersByChain.base as readonly string[]).includes(address)) return { type: 'locker', label: 'Known LP locker', evidence: 'known_protocol_registry' }
  return null
}

const pct = (part: number | bigint, total: number | bigint): number | null => {
  const t = typeof total === 'bigint' ? total : BigInt(Math.round(total))
  const p = typeof part === 'bigint' ? part : BigInt(Math.round(part))
  return t > BigInt(0) ? Math.round(Number((p * BigInt(1_000_000)) / t)) / 10_000 : null
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export async function resolveV4ControllerAttribution(
  input: { senders: Map<string, SenderStats>; positionManagerEvents: number; hook: string | null; reachedPoolCreation: boolean },
  deps: { rpc: ControllerRpc; deadline: number; now: () => number },
): Promise<V4ControllerAttribution> {
  const { rpc, deadline, now } = deps
  const hook = input.hook && input.hook !== ZERO ? input.hook.toLowerCase() : null
  const req = { network: 0, codeReads: 0, multicallBatches: 0, multicallSubcalls: 0, ownerCodeReads: 0 }
  let deadlineHit = false
  const send = async (method: string, params: unknown[]): Promise<{ result: unknown; error: string | null } | null> => {
    if (now() >= deadline) { deadlineHit = true; return null }
    if (req.network >= V4_CONTROLLER_MAX_REQUESTS) return null
    req.network++
    return rpc(method, params, Math.max(1, deadline - now()))
  }
  const getCode = async (address: string, counter: 'codeReads' | 'ownerCodeReads'): Promise<CodeInfo | null> => {
    const c = codeCache.get(key(address))
    if (c && c.expiresAt > now()) return c.info
    const res = await send('eth_getCode', [address, 'latest'])
    if (!res) return null
    req[counter]++
    const info = res.error ? null : classifyCode(res.result)
    if (info) { bounded(codeCache); codeCache.set(key(address), { expiresAt: now() + CODE_TTL_MS, info }) }
    return info
  }

  const nonPmEvents = [...input.senders.values()].reduce((s, v) => s + v.events, 0)
  const totalEvents = nonPmEvents + input.positionManagerEvents
  const ordered = [...input.senders.entries()].sort((a, b) => b[1].events - a[1].events || (a[0] < b[0] ? -1 : 1))
  const rows: V4ControllerRow[] = ordered.map(([address, s]) => ({
    address, type: 'unknown', role: 'unverified', evidence: ['direct_modify_liquidity'], label: null,
    activityCount: s.events, addEvents: s.adds, removeEvents: s.removes, netLiquidityRaw: s.net.toString(),
    shareOfObservedActivity: pct(s.events, totalEvents), sampleTxs: s.txs.slice(0, 3),
    controllerAddress: null, controllerType: null, controllerSource: null, safe: null, confidence: 'low',
    reason: 'Direct liquidity modifier; not classified within the bounded read budget.',
  }))

  // 1) Registry (no network).
  const needCode: V4ControllerRow[] = []
  for (const r of rows) {
    const id = registryIdentity(r.address, hook)
    if (!id) { needCode.push(r); continue }
    r.type = id.type
    r.label = id.label
    r.evidence.push(id.evidence)
    r.confidence = 'high'
    if (id.type === 'router') { r.role = 'intermediary'; r.reason = 'Known router / periphery contract — an intermediary that submitted liquidity changes, not the liquidity controller.' }
    else if (id.type === 'hook') { r.role = 'hook'; r.reason = 'Hook-managed liquidity activity observed; the hook is not treated as the liquidity owner without separate custody proof.' }
    else if (id.type === 'position_manager') { r.role = 'intermediary'; r.reason = `${id.label} — its position owners are not indexed here, so it is an intermediary only.` }
    else { r.role = 'unverified'; r.reason = 'Known LP locker contract; beneficiary not read.' }
  }

  // 2) eth_getCode for the top unregistered senders (bounded).
  const codeTargets = needCode.slice(0, V4_CONTROLLER_MAX_CODE_READS)
  const codes = new Map<string, CodeInfo | null>()
  for (const r of codeTargets) codes.set(r.address, await getCode(r.address, 'codeReads'))
  const contracts: Array<{ row: V4ControllerRow; info: CodeInfo }> = []
  for (const r of codeTargets) {
    const info = codes.get(r.address)
    if (!info) { r.reason = 'Direct liquidity modifier; its code could not be read.'; continue }
    if (info.kind === 'eoa') {
      Object.assign(r, { type: 'eoa', role: 'direct_controller', confidence: 'high', controllerAddress: r.address, controllerType: 'eoa', reason: 'Externally owned wallet that directly submitted these liquidity changes — direct controller of this activity, not proof of owning all pool liquidity.' })
    } else if (info.kind === 'eip7702') {
      Object.assign(r, { type: 'smart_wallet', role: 'direct_controller', confidence: 'high', controllerAddress: r.address, controllerType: 'smart_wallet', reason: `Wallet account with EIP-7702 delegated code (delegate ${info.delegate}) that directly submitted these liquidity changes.` })
      r.evidence.push('verified_contract_identity')
    } else {
      r.type = 'contract'
      r.reason = 'Contract modified liquidity; its controller could not be verified.'
      contracts.push({ row: r, info })
    }
  }

  // 3) ONE Multicall3 for every bytecode-gated control read (cached per contract).
  const sub: Multicall3SubCall[] = []
  const plan: Array<{ row: V4ControllerRow; info: CodeInfo; slots: Partial<Record<'owner' | 'getOwner' | 'admin' | 'owners' | 'threshold', number>> }> = []
  const reads = new Map<string, ControlRead>()
  for (const c of contracts) {
    const cached = controlCache.get(key(c.row.address))
    if (cached && cached.expiresAt > now()) { reads.set(c.row.address, cached.value); continue }
    const slots: (typeof plan)[number]['slots'] = {}
    const add = (name: keyof typeof slots, sel: string) => { if (sub.length < V4_CONTROLLER_MAX_SUBCALLS) slots[name] = sub.push({ target: c.row.address, callData: sel }) - 1 }
    if (c.info.safeLike) { add('owners', SEL_GET_OWNERS); add('threshold', SEL_GET_THRESHOLD) }
    if (c.info.hasOwner) add('owner', SEL_OWNER)
    if (c.info.hasGetOwner) add('getOwner', SEL_GET_OWNER)
    if (c.info.hasAdmin) add('admin', SEL_ADMIN)
    if (Object.keys(slots).length) plan.push({ ...c, slots })
  }
  let multicallFailed = false
  if (sub.length > 0) {
    const res = await send('eth_call', [{ to: MULTICALL3_ADDRESS, data: encodeAggregate3(sub) }, 'latest'])
    if (res) { req.multicallBatches = 1; req.multicallSubcalls = sub.length }
    const decoded = res && !res.error ? decodeAggregate3(res.result, sub.length) : null
    if (!decoded) multicallFailed = res != null
    else {
      const at = (i: number | undefined) => (i != null && decoded[i]?.success ? decoded[i].returnData : null)
      for (const p of plan) {
        const owners = at(p.slots.owners) ? decodeAddressArray(at(p.slots.owners)!) : null
        const threshold = at(p.slots.threshold) ? decodeSmallUint(at(p.slots.threshold)!) : null
        const addr = (i: number | undefined) => { const h = at(i); const a = h ? decodeAddressWord(h) : null; return a && a !== ZERO ? a : null }
        let v: ControlRead = { controller: null, source: null, safe: null }
        if (owners && threshold != null && threshold >= 1 && threshold <= owners.length) v = { controller: null, source: 'safe_owners', safe: { owners, threshold } }
        else if (addr(p.slots.owner)) v = { controller: addr(p.slots.owner), source: 'owner', safe: null }
        else if (addr(p.slots.getOwner)) v = { controller: addr(p.slots.getOwner), source: 'getOwner', safe: null }
        else if (addr(p.slots.admin)) v = { controller: addr(p.slots.admin), source: 'admin', safe: null }
        reads.set(p.row.address, v)
        bounded(controlCache)
        controlCache.set(key(p.row.address), { expiresAt: now() + CONTROL_TTL_MS, value: v })
      }
    }
  }

  // 4) Apply control reads; type the resolved owner/admin (bounded eth_getCode).
  let ownerCodeBudget = V4_CONTROLLER_MAX_OWNER_CODE_READS
  for (const c of contracts) {
    const v = reads.get(c.row.address)
    const r = c.row
    if (v?.safe) {
      Object.assign(r, { type: 'multisig', role: 'contract_controlled', confidence: 'medium', controllerSource: 'safe_owners', safe: v.safe, controllerType: null,
        reason: `Safe-style multisig (${v.safe.threshold} of ${v.safe.owners.length} owners) submitted these liquidity changes — contract controlled by its signers.` })
      r.evidence.push('verified_contract_identity', 'verified_owner_read')
      continue
    }
    if (v?.controller) {
      let ctype: V4ControllerRow['controllerType'] = 'unknown'
      if (ownerCodeBudget > 0) {
        ownerCodeBudget--
        const info = await getCode(v.controller, 'ownerCodeReads')
        ctype = info ? (info.kind === 'eoa' ? 'eoa' : info.kind === 'eip7702' ? 'smart_wallet' : 'contract') : 'unknown'
      }
      Object.assign(r, { role: 'contract_controlled', confidence: 'medium', controllerAddress: v.controller, controllerSource: v.source, controllerType: ctype,
        reason: `Contract controlled by ${v.controller} (${v.source === 'admin' ? 'admin()' : v.source === 'getOwner' ? 'getOwner()' : 'owner()'}${ctype === 'eoa' ? ', a wallet' : ctype === 'contract' ? ', a contract' : ''}) — control of the contract, not proof that this address owns the liquidity.` })
      r.evidence.push(v.source === 'admin' ? 'verified_admin_read' : 'verified_owner_read')
      continue
    }
    r.role = 'unverified'
    r.reason = multicallFailed ? 'Contract modified liquidity; its control reads failed.' : 'Contract modified liquidity; no verifiable owner/admin interface was found.'
  }

  // Aggregates.
  const attributed = rows.filter((r) => r.role === 'direct_controller' || r.role === 'contract_controlled')
  const unattributedEvents = rows.filter((r) => !attributed.includes(r)).reduce((s, r) => s + r.activityCount, 0)
  const eoaMods = rows.filter((r) => r.type === 'eoa' || r.type === 'smart_wallet').length
  const intermediaries = rows.filter((r) => r.role === 'intermediary').length
  const contractMods = rows.length - eoaMods
  const top = rows[0] ?? null
  const positiveNet = rows.reduce((s, r) => s + (BigInt(r.netLiquidityRaw) > BigInt(0) ? BigInt(r.netLiquidityRaw) : BigInt(0)), BigInt(0))
  const topAdder = [...rows].sort((a, b) => (BigInt(b.netLiquidityRaw) > BigInt(a.netLiquidityRaw) ? 1 : -1))[0]
  const topEventShare = top ? pct(top.activityCount, totalEvents) : null
  const topNetShare = topAdder && BigInt(topAdder.netLiquidityRaw) > BigInt(0) ? pct(BigInt(topAdder.netLiquidityRaw), positiveNet) : null

  const typeCounts = new Map<string, number>()
  const typeName: Record<V4ControllerType, [string, string]> = {
    eoa: ['wallet (EOA)', 'wallets (EOA)'], smart_wallet: ['delegated wallet', 'delegated wallets'], router: ['router contract', 'router contracts'], hook: ['hook contract', 'hook contracts'],
    position_manager: ['non-canonical position manager', 'non-canonical position managers'], multisig: ['multisig', 'multisigs'], locker: ['locker contract', 'locker contracts'], vault: ['vault', 'vaults'],
    contract: ['contract', 'contracts'], unknown: ['unclassified address', 'unclassified addresses'],
  }
  for (const r of rows) typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1)
  const parts = [...typeCounts.entries()].map(([t, n]) => `${n} ${typeName[t as V4ControllerType][n === 1 ? 0 : 1]}`)
  const controllerSummary = rows.length === 0 ? 'No liquidity activity outside the canonical PositionManager.'
    : `${nonPmEvents} liquidity event${nonPmEvents === 1 ? '' : 's'} from ${parts.join(', ')}`

  let status: V4ControllerAttribution['status']
  let publicText: string
  if (rows.length === 0) { status = 'unavailable_with_reason'; publicText = 'No liquidity activity outside the canonical PositionManager was observed.' }
  else if (attributed.length === 0) {
    status = 'unavailable_with_reason'
    const allRouters = rows.every((r) => r.role === 'intermediary')
    const allHooks = rows.every((r) => r.role === 'hook')
    publicText = allRouters ? 'Liquidity activity was routed through a periphery contract, but the final liquidity controller could not be verified.'
      : allHooks ? 'Hook-managed liquidity activity observed; the final liquidity controller could not be verified.'
        : 'Liquidity activity came from contract(s) whose controller could not be verified.'
  } else {
    const complete = unattributedEvents === 0 && input.reachedPoolCreation && !deadlineHit
    status = complete ? 'verified' : 'partial'
    const a = attributed[0]
    const lead = a.role === 'direct_controller' ? `direct controller ${a.address}` : a.safe ? `multisig ${a.address} (${a.safe.threshold} of ${a.safe.owners.length})` : `contract ${a.address} controlled by ${a.controllerAddress}`
    publicText = `${complete ? 'Controller attribution verified' : 'Controller attribution partial'} — ${attributed.length} of ${rows.length} liquidity modifier${rows.length === 1 ? '' : 's'} attributed (${lead})${complete ? '' : `; ${unattributedEvents} of ${nonPmEvents} event(s) unattributed`}. Controller of observed activity, not proof of owning all pool liquidity.`
  }
  const concentrationText = top && topEventShare != null
    ? `${topEventShare}% of observed liquidity-change activity came from one ${top.role === 'intermediary' ? 'intermediary' : 'modifier'} address (${short(top.address)}).`
    : null

  return {
    status, publicText, controllerSummary, controllers: rows.slice(0, 20),
    hook: hook ? { address: hook, label: BASE_UNISWAP_OFFICIAL_CONTRACTS[hook]?.label ?? null, isModifier: rows.some((r) => r.address === hook) } : null,
    totalObservedEvents: totalEvents, positionManagerEvents: input.positionManagerEvents, nonPositionManagerEvents: nonPmEvents, unattributedEvents,
    concentration: { label: 'Liquidity activity concentration', uniqueModifiers: rows.length, eoaModifiers: eoaMods, contractModifiers: contractMods, intermediaryModifiers: intermediaries, topModifier: top?.address ?? null, topModifierEventSharePct: topEventShare, topModifierNetAddSharePct: topNetShare, text: concentrationText },
    coverage: { reachedPoolCreation: input.reachedPoolCreation, classified: rows.filter((r) => r.type !== 'unknown').length, unclassified: rows.filter((r) => r.type === 'unknown').length, codeReads: req.codeReads + req.ownerCodeReads, controlReads: req.multicallSubcalls, multicallFailed, deadlineHit },
    requests: req,
  }
}
