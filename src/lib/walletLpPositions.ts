// Open concentrated-liquidity positions a wallet created, valued at current prices.
//
// A concentrated LP position is an NFT, so it never shows up in the wallet's ERC-20 holdings — and an
// LP zapper usually mints it to the zap contract and stakes it in a gauge, so the wallet does not own
// it directly either. A position is attributed to the wallet only when its NFT was MINTED inside one of
// the wallet's own liquidity transactions (the scan's liquidity tx set): the wallet sent the tokens that
// fund it. Positions whose liquidity is now zero (withdrawn, or burned on a rebalance) are skipped.
//
// Amounts use the standard concentrated-liquidity formula at the current market price ratio of the
// two tokens (from their current USD prices), not the pool's own slot0, so a position in a pool from a
// factory this codebase cannot validate is still valued. Uncollected fees (tokensOwed) are added as
// recorded on the position. A position with a token that has no current price is listed but not valued.

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const POSITIONS_SELECTOR = '0x99fbab88' // positions(uint256)
const DECIMALS_SELECTOR = '0x313ce567' // decimals()

// Base NonfungiblePositionManagers whose positions() return the same 12-word layout (Slipstream has
// int24 tickSpacing where Uniswap V3 has uint24 fee). Same addresses as lib/server/lpProof.ts.
// Known managers only name the protocol: discovery reads every NFT minted in the wallet's own liquidity
// transactions, so a manager not listed here (Aerodrome deploys new Slipstream managers alongside new
// factories) is still found, and counts only if its positions() answers in this exact layout.
export const BASE_POSITION_MANAGERS: Readonly<Record<string, 'aerodrome_slipstream' | 'uniswap_v3'>> = {
  '0x827922686190790b37229fd06084350e74485b72': 'aerodrome_slipstream',
  '0x03a520b32c04bf3beef7beb72e919cf822ed34f1': 'uniswap_v3',
}

export const MAX_LP_POSITION_LOOKUPS = 30
export const MAX_LP_POSITION_BATCHES = 3
export const MAX_LP_DISCOVERY_ADDRESSES = 4
/** Most recent NFT mints read per discovery address (Alchemy's per-call maximum). */
export const MAX_LP_DISCOVERY_TRANSFERS = 1000
export const LP_POSITIONS_BUDGET_MS = 8_000

export type DecodedPosition = {
  token0: string
  token1: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}

export type WalletLpPosition = {
  positionManager: string
  protocol: 'aerodrome_slipstream' | 'uniswap_v3' | 'unlisted_manager'
  tokenId: string
  mintTxHash: string
  token0: string
  token1: string
  amount0: number
  amount1: number
  inRange: boolean
  valueUsd: number | null
}

export type WalletLpPositionsSummary = {
  status: 'ok' | 'partial' | 'not_attempted' | 'unavailable'
  reason: string | null
  positions: WalletLpPosition[]
  openPositions: number
  pricedPositions: number
  totalValueUsd: number
  mintsFound: number
  /** Distinct contracts that minted position NFTs in the wallet's own liquidity transactions. */
  positionManagers: string[]
  closedPositionsSkipped: number
  /** How the checked positions came back: burned (reverted), zero liquidity, or a failed read. */
  positionsChecked: number
  burnedPositions: number
  zeroLiquidityPositions: number
  positionReadErrors: number
  sampleReadError: string | null
  rpcCalls: number
}

export const emptyLpPositionsSummary = (status: WalletLpPositionsSummary['status'], reason: string | null): WalletLpPositionsSummary => ({
  status, reason, positions: [], openPositions: 0, pricedPositions: 0, totalValueUsd: 0, mintsFound: 0, positionManagers: [], closedPositionsSkipped: 0, rpcCalls: 0,
  positionsChecked: 0, burnedPositions: 0, zeroLiquidityPositions: 0, positionReadErrors: 0, sampleReadError: null,
})

function word(hex: string, index: number): string {
  return hex.slice(2 + index * 64, 2 + (index + 1) * 64)
}

function signed24(wordHex: string): number {
  const v = BigInt(`0x${wordHex}`) & BigInt(0xffffff)
  return Number(v >= BigInt(0x800000) ? v - BigInt(0x1000000) : v)
}

const ZERO_TOKEN = `0x${'0'.repeat(40)}`

/**
 * PURE. Decodes a positions(uint256) return value; null for any other shape, including one no
 * V3-style manager can return (unsorted or zero tokens, tickLower >= tickUpper).
 */
export function decodePositions(hex: string | null | undefined): DecodedPosition | null {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex) || hex.length !== 2 + 12 * 64) return null
  const decoded = {
    token0: `0x${word(hex, 2).slice(24)}`.toLowerCase(),
    token1: `0x${word(hex, 3).slice(24)}`.toLowerCase(),
    tickLower: signed24(word(hex, 5)),
    tickUpper: signed24(word(hex, 6)),
    liquidity: BigInt(`0x${word(hex, 7)}`),
    tokensOwed0: BigInt(`0x${word(hex, 10)}`),
    tokensOwed1: BigInt(`0x${word(hex, 11)}`),
  }
  if (decoded.token0 === ZERO_TOKEN || decoded.token1 === ZERO_TOKEN || decoded.token0 >= decoded.token1) return null
  if (decoded.tickLower >= decoded.tickUpper) return null
  return decoded
}

/**
 * PURE. Raw token amounts held by `liquidity` between two ticks at `priceRaw` (token1 raw units per
 * token0 raw unit).
 */
export function positionAmounts(liquidity: bigint, tickLower: number, tickUpper: number, priceRaw: number): { amount0Raw: number; amount1Raw: number; inRange: boolean } {
  const L = Number(liquidity)
  const sa = Math.pow(1.0001, tickLower / 2)
  const sb = Math.pow(1.0001, tickUpper / 2)
  const sp = Math.sqrt(priceRaw)
  if (!(L > 0) || !(sb > sa) || !Number.isFinite(sp) || sp <= 0) return { amount0Raw: 0, amount1Raw: 0, inRange: false }
  if (sp <= sa) return { amount0Raw: (L * (sb - sa)) / (sa * sb), amount1Raw: 0, inRange: false }
  if (sp >= sb) return { amount0Raw: 0, amount1Raw: L * (sb - sa), inRange: false }
  return { amount0Raw: (L * (sb - sp)) / (sp * sb), amount1Raw: L * (sp - sa), inRange: true }
}

export type LpRpc = (body: unknown) => Promise<unknown>

export type ResolveWalletLpPositionsInput = {
  walletAddress: string
  /** `${chain}:${txHash}` of the wallet's own liquidity transactions (src/lib/liquidityLegGuard.ts). */
  liquidityTxKeys: ReadonlySet<string>
  /** Contracts the wallet sends liquidity to (zappers); an NFT minted to one of them can be the wallet's. */
  counterparties: readonly string[]
  rpc: LpRpc
  priceUsd: (token: string) => number | null
  /** Called before each RPC request; false skips it (shared scan budget). */
  consume?: (method: 'alchemy_getAssetTransfers' | 'eth_call') => boolean
  now?: () => number
  budgetMs?: number
}

type RpcResponse = { id?: unknown; result?: unknown; error?: unknown }

// How a position manager reverts positions() for a burned token: Uniswap V3 says "Invalid token ID",
// Aerodrome Slipstream reverts with the bare reason "ID" (production: "execution reverted: ID").
const BURNED_POSITION_ERROR = /invalid token id|(?:^|reverted:?\s*)ID\s*$/i

function errorText(error: unknown): string | null {
  if (error == null) return null
  if (typeof error === 'string') return error.slice(0, 160)
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message.slice(0, 160) : JSON.stringify(error).slice(0, 160)
}

function asArray(value: unknown): RpcResponse[] {
  return Array.isArray(value) ? (value as RpcResponse[]) : value && typeof value === 'object' ? [value as RpcResponse] : []
}

/** Base only. Never throws: failures come back as status 'unavailable' or 'partial' with a reason. */
export async function resolveWalletLpPositions(input: ResolveWalletLpPositionsInput): Promise<WalletLpPositionsSummary> {
  const now = input.now ?? Date.now
  const deadline = now() + (input.budgetMs ?? LP_POSITIONS_BUDGET_MS)
  const consume = input.consume ?? (() => true)
  const summary = emptyLpPositionsSummary('ok', null)
  const ownTxHashes = new Set([...input.liquidityTxKeys].filter((k) => k.startsWith('base:')).map((k) => k.slice(5).toLowerCase()))
  if (ownTxHashes.size === 0) return emptyLpPositionsSummary('not_attempted', 'no_liquidity_transactions')
  const addresses = [...new Set([input.walletAddress, ...input.counterparties].map((a) => a.toLowerCase()))].slice(0, MAX_LP_DISCOVERY_ADDRESSES)

  try {
    // 1. Position NFTs minted to the wallet or its zappers, kept only when minted in the wallet's own tx.
    type Mint = { manager: string; tokenId: bigint; txHash: string; blockNum: number }
    const mints = new Map<string, Mint>()
    let discoveryIncomplete = false
    for (const to of addresses) {
      if (now() > deadline || !consume('alchemy_getAssetTransfers')) { discoveryIncomplete = true; continue }
      summary.rpcCalls += 1
      const response = asArray(await input.rpc({
        jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers',
        params: [{ fromAddress: ZERO_ADDRESS, toAddress: to, category: ['erc721'], order: 'desc', maxCount: `0x${MAX_LP_DISCOVERY_TRANSFERS.toString(16)}`, withMetadata: false }],
      }))[0]
      const transfers = (response?.result as { transfers?: unknown } | undefined)?.transfers
      if (!Array.isArray(transfers)) { discoveryIncomplete = true; continue }
      for (const t of transfers as Array<Record<string, unknown>>) {
        const txHash = typeof t.hash === 'string' ? t.hash.toLowerCase() : null
        const idHex = typeof t.erc721TokenId === 'string' ? t.erc721TokenId : typeof t.tokenId === 'string' ? t.tokenId : null
        const contract = (t.rawContract as { address?: unknown } | undefined)?.address
        const manager = typeof contract === 'string' && /^0x[0-9a-fA-F]{40}$/.test(contract) ? contract.toLowerCase() : null
        if (!txHash || !idHex || !manager || !ownTxHashes.has(txHash)) continue
        const tokenId = BigInt(idHex)
        mints.set(`${manager}:${tokenId}`, { manager, tokenId, txHash, blockNum: typeof t.blockNum === 'string' ? Number(BigInt(t.blockNum)) : 0 })
      }
    }
    summary.mintsFound = mints.size
    summary.positionManagers = [...new Set([...mints.values()].map((m) => m.manager))]
    if (mints.size === 0) {
      return { ...summary, status: discoveryIncomplete ? 'unavailable' : 'ok', reason: discoveryIncomplete ? 'position_discovery_failed' : 'no_positions_minted_in_wallet_transactions' }
    }

    // 2. Current state, newest first, in batches. A burned position reverts with "Invalid token ID" and a
    // withdrawn one has zero liquidity: both are closed. Any other failure is a read error and is counted
    // separately, never as closed. A batch with nothing open (and no read errors) moves on to older
    // mints, up to MAX_LP_POSITION_BATCHES batches.
    const ordered = [...mints.values()].sort((a, b) => b.blockNum - a.blockNum || (a.tokenId < b.tokenId ? 1 : -1))
    const open: Array<{ mint: Mint; position: DecodedPosition }> = []
    for (let batch = 0; batch < MAX_LP_POSITION_BATCHES; batch++) {
      const selected = ordered.slice(batch * MAX_LP_POSITION_LOOKUPS, (batch + 1) * MAX_LP_POSITION_LOOKUPS)
      if (selected.length === 0) break
      if (now() > deadline || !consume('eth_call')) {
        if (batch === 0) return { ...summary, status: 'unavailable', reason: 'budget_exhausted_before_position_reads' }
        summary.reason = 'position_reads_stopped_by_budget'
        break
      }
      summary.rpcCalls += 1
      const positionResponses = asArray(await input.rpc(selected.map((m, i) => ({
        jsonrpc: '2.0', id: i, method: 'eth_call',
        params: [{ to: m.manager, data: `${POSITIONS_SELECTOR}${m.tokenId.toString(16).padStart(64, '0')}` }, 'latest'],
      }))))
      const byId = new Map(positionResponses.map((r) => [Number(r.id), r]))
      const errorsBefore = summary.positionReadErrors
      for (let i = 0; i < selected.length; i++) {
        summary.positionsChecked += 1
        const response = byId.get(i)
        const errorMessage = errorText(response?.error)
        if (errorMessage != null && BURNED_POSITION_ERROR.test(errorMessage)) { summary.burnedPositions += 1; continue }
        if (!response || errorMessage != null) {
          summary.positionReadErrors += 1
          summary.sampleReadError ??= errorMessage ?? 'no_response_for_request'
          continue
        }
        const position = decodePositions(response.result as string | undefined)
        if (!position) {
          summary.positionReadErrors += 1
          summary.sampleReadError ??= `unexpected_result:${String(response.result).slice(0, 40)}`
          continue
        }
        if (position.liquidity === BigInt(0)) { summary.zeroLiquidityPositions += 1; continue }
        open.push({ mint: selected[i], position })
      }
      if (open.length > 0 || summary.positionReadErrors > errorsBefore) break
    }
    summary.closedPositionsSkipped = summary.burnedPositions + summary.zeroLiquidityPositions
    summary.openPositions = open.length
    if (open.length === 0) {
      if (summary.positionReadErrors > 0) {
        const allFailed = summary.positionReadErrors === summary.positionsChecked
        return { ...summary, status: allFailed ? 'unavailable' : 'partial', reason: allFailed ? 'position_reads_failed' : 'some_position_reads_failed' }
      }
      // Stopped before reaching every mint: closed so far is not the same as none open.
      if (summary.reason === 'position_reads_stopped_by_budget') summary.status = 'partial'
      return summary
    }

    // 3. Token decimals, one batch.
    const tokens = [...new Set(open.flatMap(({ position }) => [position.token0, position.token1]))]
    const decimals = new Map<string, number>()
    if (now() <= deadline && consume('eth_call')) {
      summary.rpcCalls += 1
      const decimalResponses = asArray(await input.rpc(tokens.map((token, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: token, data: DECIMALS_SELECTOR }, 'latest'] }))))
      for (const r of decimalResponses) {
        const value = typeof r.result === 'string' && /^0x[0-9a-fA-F]+$/.test(r.result) ? Number(BigInt(r.result)) : NaN
        if (Number.isInteger(value) && value >= 0 && value <= 36) decimals.set(tokens[Number(r.id)], value)
      }
    }

    // 4. Amounts and value at current prices.
    for (const { mint, position } of open) {
      const d0 = decimals.get(position.token0)
      const d1 = decimals.get(position.token1)
      const p0 = input.priceUsd(position.token0)
      const p1 = input.priceUsd(position.token1)
      const base = {
        positionManager: mint.manager, protocol: BASE_POSITION_MANAGERS[mint.manager] ?? 'unlisted_manager', tokenId: mint.tokenId.toString(), mintTxHash: mint.txHash,
        token0: position.token0, token1: position.token1,
      }
      if (d0 == null || d1 == null || p0 == null || p1 == null || !(p0 > 0) || !(p1 > 0)) {
        summary.positions.push({ ...base, amount0: 0, amount1: 0, inRange: false, valueUsd: null })
        continue
      }
      const priceRaw = (p0 / p1) * Math.pow(10, d1 - d0)
      const { amount0Raw, amount1Raw, inRange } = positionAmounts(position.liquidity, position.tickLower, position.tickUpper, priceRaw)
      const amount0 = (amount0Raw + Number(position.tokensOwed0)) / Math.pow(10, d0)
      const amount1 = (amount1Raw + Number(position.tokensOwed1)) / Math.pow(10, d1)
      const valueUsd = amount0 * p0 + amount1 * p1
      summary.positions.push({ ...base, amount0, amount1, inRange, valueUsd: Number.isFinite(valueUsd) ? valueUsd : null })
    }
    summary.positions.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1))
    const priced = summary.positions.filter((p) => p.valueUsd != null)
    summary.pricedPositions = priced.length
    summary.totalValueUsd = priced.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0)
    if (discoveryIncomplete || summary.positionReadErrors > 0 || priced.length < summary.positions.length) {
      summary.status = 'partial'
      summary.reason = discoveryIncomplete ? 'position_discovery_incomplete'
        : summary.positionReadErrors > 0 ? 'some_position_reads_failed' : 'some_positions_unpriced'
    }
    return summary
  } catch (err) {
    return { ...summary, status: 'unavailable', reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown_error' }
  }
}
