// Separates a swap's token outflow from a liquidity change in the same receipt.
// A transfer is kept only when its raw amount is the swap's own token-out (or the
// pool-origin transfers of this token sum to that out). Anything else stays unattributed.
// Never guesses which side of an ambiguous pair is the buy.

const TOLERANCE = BigInt(1)
const WORD = BigInt(1) << BigInt(256)
const SIGN = BigInt(1) << BigInt(255)

export type MixedLog = { address?: string; topics?: string[]; data?: string; removed?: boolean; logIndex?: string }

function words(data: string | undefined): bigint[] | null {
  if (typeof data !== 'string' || !/^0x[0-9a-f]*$/i.test(data)) return null
  const body = data.slice(2)
  if (body.length < 64 || body.length % 64 !== 0) return null
  const out: bigint[] = []
  for (let i = 0; i < body.length; i += 64) out.push(BigInt(`0x${body.slice(i, i + 64)}`))
  return out
}

function signed(word: bigint): bigint {
  return word >= SIGN ? word - WORD : word
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a
}

/** Token amount the pool paid out on one swap, or null when the event is not a single-sided out. */
export function swapTokenOut(protocol: 'v2' | 'aerodrome_v2' | 'v3' | 'slipstream' | 'v4', data: string | undefined): bigint | null {
  const decoded = words(data)
  if (!decoded) return null
  if (protocol === 'v2' || protocol === 'aerodrome_v2') {
    if (decoded.length < 4) return null
    const outs = [decoded[2], decoded[3]].filter((amount) => amount > BigInt(0))
    return outs.length === 1 ? outs[0] : null
  }
  if (decoded.length < 2) return null
  const negative = [signed(decoded[0]), signed(decoded[1])].filter((amount) => amount < BigInt(0))
  return negative.length === 1 ? -negative[0] : null
}

/**
 * Pool-origin transfers of `token` to keep. Null means the swap cannot be separated
 * from the liquidity change, so the caller must not attribute the receipt.
 */
export function separablePoolTransfers<T extends { from: string; rawAmount: bigint }>(input: {
  protocol: 'v2' | 'aerodrome_v2' | 'v3' | 'slipstream' | 'v4'
  swapDatas: string[]
  poolSource: string
  transfers: T[]
}): T[] | null {
  let expected = BigInt(0)
  let swaps = 0
  for (const data of input.swapDatas) {
    const out = swapTokenOut(input.protocol, data)
    if (out == null || out <= BigInt(0)) return null
    expected += out
    swaps += 1
  }
  if (swaps === 0) return null
  const source = input.poolSource.toLowerCase()
  const fromPool = input.transfers.filter((transfer) => transfer.from.toLowerCase() === source && transfer.rawAmount > BigInt(0))
  if (fromPool.length === 0) return null
  const exact = fromPool.filter((transfer) => absDiff(transfer.rawAmount, expected) <= TOLERANCE)
  if (exact.length === 1) return input.transfers.filter((transfer) => transfer.from.toLowerCase() !== source || exact.includes(transfer))
  if (exact.length > 1) return null
  const sum = fromPool.reduce((total, transfer) => total + transfer.rawAmount, BigInt(0))
  if (absDiff(sum, expected) <= TOLERANCE) return input.transfers
  return null
}
