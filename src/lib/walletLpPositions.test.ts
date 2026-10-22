// Open LP positions: attribution by mint-in-own-transaction, closed positions skipped, valuation math.
//   npx tsx --test src/lib/walletLpPositions.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodePositions, positionAmounts, resolveWalletLpPositions } from './walletLpPositions'

const WALLET = '0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811'
const ZAPPER = '0x3295f76956165dea7acbb6619d69d6dee57cf517'
const SLIPSTREAM = '0x827922686190790b37229fd06084350e74485b72'
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const OWN_TX = `0x${'a'.repeat(64)}`
const OTHER_TX = `0x${'b'.repeat(64)}`

const w = (v: bigint | number) => {
  let n = BigInt(v)
  if (n < BigInt(0)) n = (BigInt(1) << BigInt(256)) + n
  return n.toString(16).padStart(64, '0')
}
const addr = (a: string) => a.slice(2).padStart(64, '0')
function positionsHex(p: { token0: string; token1: string; tickLower: number; tickUpper: number; liquidity: bigint; owed0?: bigint; owed1?: bigint }) {
  return `0x${w(0)}${w(0)}${addr(p.token0)}${addr(p.token1)}${w(100)}${w(p.tickLower)}${w(p.tickUpper)}${w(p.liquidity)}${w(0)}${w(0)}${w(p.owed0 ?? BigInt(0))}${w(p.owed1 ?? BigInt(0))}`
}

describe('decodePositions', () => {
  it('reads tokens, signed ticks and liquidity; rejects other shapes', () => {
    const d = decodePositions(positionsHex({ token0: WETH, token1: USDC, tickLower: -200000, tickUpper: -190000, liquidity: BigInt(123) }))
    assert.deepEqual(d && { ...d, liquidity: d.liquidity.toString() }, { token0: WETH, token1: USDC, tickLower: -200000, tickUpper: -190000, liquidity: '123', tokensOwed0: BigInt(0), tokensOwed1: BigInt(0) })
    assert.equal(decodePositions('0x'), null)
    assert.equal(decodePositions(undefined), null)
  })
})

describe('positionAmounts', () => {
  it('in range holds both tokens; below range only token0; above range only token1', () => {
    const L = BigInt(1e12)
    const mid = positionAmounts(L, -1000, 1000, 1)
    assert.equal(mid.inRange, true)
    assert.ok(mid.amount0Raw > 0 && mid.amount1Raw > 0)
    assert.ok(Math.abs(mid.amount0Raw - mid.amount1Raw) / mid.amount0Raw < 1e-9, 'symmetric range at price 1 holds equal amounts')
    const below = positionAmounts(L, 1000, 2000, 1)
    assert.deepEqual([below.amount1Raw, below.inRange], [0, false])
    assert.ok(below.amount0Raw > 0)
    const above = positionAmounts(L, -2000, -1000, 1)
    assert.deepEqual([above.amount0Raw, above.inRange], [0, false])
  })
})

describe('resolveWalletLpPositions', () => {
  // ETH at $2,500, USDC at $1: price of WETH in raw USDC units per raw wei = 2500 * 1e6 / 1e18.
  const tick = Math.round(Math.log(2500 * 1e-12) / Math.log(1.0001))
  function rpc(liquidityById: Record<string, bigint>) {
    const calls: string[] = []
    const fn = async (body: unknown) => {
      if (Array.isArray(body)) {
        const reqs = body as Array<{ id: number; params: [{ to: string; data: string }] }>
        calls.push(reqs[0].params[0].data.slice(0, 10))
        return reqs.map((r) => {
          if (r.params[0].data === '0x313ce567') return { id: r.id, result: `0x${w(r.params[0].to === WETH ? 18 : 6)}` }
          const id = BigInt(`0x${r.params[0].data.slice(10)}`).toString()
          const liquidity = liquidityById[id]
          return liquidity == null
            ? { id: r.id, error: { message: 'Invalid token ID' } }
            : { id: r.id, result: positionsHex({ token0: WETH, token1: USDC, tickLower: tick - 600, tickUpper: tick + 600, liquidity }) }
        })
      }
      const req = body as { params: [{ toAddress: string; contractAddresses: string[] }] }
      calls.push(`transfers:${req.params[0].toAddress}:${req.params[0].contractAddresses[0]}`)
      if (req.params[0].toAddress !== ZAPPER || req.params[0].contractAddresses[0] !== SLIPSTREAM) return { result: { transfers: [] } }
      return { result: { transfers: [
        { hash: OWN_TX, erc721TokenId: '0x1', blockNum: '0x10' },
        { hash: OWN_TX, erc721TokenId: '0x2', blockNum: '0x11' },
        { hash: OTHER_TX, erc721TokenId: '0x3', blockNum: '0x12' }, // another user's mint through the same zapper
      ] } }
    }
    return { fn, calls }
  }

  it('values open positions minted in the wallet\'s own transactions; skips closed ones and other users\' mints', async () => {
    const { fn } = rpc({ '1': BigInt(1e15), '3': BigInt(1e15) }) // #2 was burned; #3 is someone else's
    const r = await resolveWalletLpPositions({
      walletAddress: WALLET, liquidityTxKeys: new Set([`base:${OWN_TX}`]), counterparties: [ZAPPER], rpc: fn,
      priceUsd: (t) => (t === WETH ? 2500 : t === USDC ? 1 : null),
    })
    assert.equal(r.mintsFound, 2)
    assert.equal(r.openPositions, 1)
    assert.equal(r.closedPositionsSkipped, 1)
    assert.equal(r.positions.length, 1)
    assert.equal(r.positions[0].tokenId, '1')
    assert.equal(r.positions[0].inRange, true)
    assert.ok(r.totalValueUsd > 0)
    const p = r.positions[0]
    assert.ok(Math.abs(p.amount0 * 2500 + p.amount1 - r.totalValueUsd) < 1e-6)
    assert.equal(r.status, 'ok')
  })

  it('lists but does not value a position whose token has no current price', async () => {
    const { fn } = rpc({ '1': BigInt(1e15) })
    const r = await resolveWalletLpPositions({
      walletAddress: WALLET, liquidityTxKeys: new Set([`base:${OWN_TX}`]), counterparties: [ZAPPER], rpc: fn,
      priceUsd: (t) => (t === WETH ? 2500 : null),
    })
    assert.equal(r.positions.length, 1)
    assert.equal(r.positions[0].valueUsd, null)
    assert.equal(r.totalValueUsd, 0)
    assert.equal(r.status, 'partial')
  })

  it('makes no calls without liquidity transactions, and stops when the budget refuses', async () => {
    const { fn, calls } = rpc({})
    const none = await resolveWalletLpPositions({ walletAddress: WALLET, liquidityTxKeys: new Set(), counterparties: [ZAPPER], rpc: fn, priceUsd: () => 1 })
    assert.equal(none.status, 'not_attempted')
    assert.equal(calls.length, 0)
    const refused = await resolveWalletLpPositions({ walletAddress: WALLET, liquidityTxKeys: new Set([`base:${OWN_TX}`]), counterparties: [ZAPPER], rpc: fn, priceUsd: () => 1, consume: () => false })
    assert.equal(refused.status, 'unavailable')
    assert.equal(calls.length, 0)
  })
})

describe('resolveWalletLpPositions: read failures and older positions', () => {
  const tick = Math.round(Math.log(2500 * 1e-12) / Math.log(1.0001))
  const own = (i: number) => `0x${i.toString(16).padStart(64, '0')}`
  // 40 mints in the wallet's own transactions; tokenId i minted at block i (higher = newer).
  function setup(readPosition: (id: number) => { result?: string; error?: { message: string } }) {
    const keys = new Set<string>()
    const transfers = Array.from({ length: 40 }, (_, k) => {
      const i = k + 1
      keys.add(`base:${own(i)}`)
      return { hash: own(i), erc721TokenId: `0x${i.toString(16)}`, blockNum: `0x${i.toString(16)}` }
    })
    const rpc = async (body: unknown) => {
      if (Array.isArray(body)) {
        const reqs = body as Array<{ id: number; params: [{ to: string; data: string }] }>
        return reqs.map((r) => r.params[0].data === '0x313ce567'
          ? { id: r.id, result: `0x${w(r.params[0].to === WETH ? 18 : 6)}` }
          : { id: r.id, ...readPosition(Number(BigInt(`0x${r.params[0].data.slice(10)}`))) })
      }
      const req = body as { params: [{ toAddress: string; contractAddresses: string[] }] }
      return { result: { transfers: req.params[0].toAddress === ZAPPER && req.params[0].contractAddresses[0] === SLIPSTREAM ? transfers : [] } }
    }
    return { rpc, keys }
  }
  const open = positionsHex({ token0: WETH, token1: USDC, tickLower: tick - 600, tickUpper: tick + 600, liquidity: BigInt(1e15) })
  const withdrawn = positionsHex({ token0: WETH, token1: USDC, tickLower: tick - 600, tickUpper: tick + 600, liquidity: BigInt(0) })
  const price = (t: string) => (t === WETH ? 2500 : t === USDC ? 1 : null)

  it('a failed read is reported as an error with a sample, never as a closed position', async () => {
    const { rpc, keys } = setup(() => ({ error: { message: 'Your app has exceeded its compute units per second capacity' } }))
    const r = await resolveWalletLpPositions({ walletAddress: WALLET, liquidityTxKeys: keys, counterparties: [ZAPPER], rpc, priceUsd: price })
    assert.equal(r.status, 'unavailable')
    assert.equal(r.reason, 'position_reads_failed')
    assert.equal(r.positionReadErrors, 30)
    assert.equal(r.closedPositionsSkipped, 0)
    assert.match(r.sampleReadError!, /compute units/)
  })

  it('when the newest 30 are all closed it checks older ones and finds the open position', async () => {
    // 40..11 newest: burned or withdrawn; 5 is still open.
    const { rpc, keys } = setup((id) => id === 5 ? { result: open } : id % 2 ? { error: { message: 'execution reverted: Invalid token ID' } } : { result: withdrawn })
    const r = await resolveWalletLpPositions({ walletAddress: WALLET, liquidityTxKeys: keys, counterparties: [ZAPPER], rpc, priceUsd: price })
    assert.equal(r.openPositions, 1)
    assert.equal(r.positions[0].tokenId, '5')
    assert.equal(r.positionsChecked, 40)
    assert.equal(r.burnedPositions + r.zeroLiquidityPositions, 39)
    assert.equal(r.positionReadErrors, 0)
    assert.equal(r.status, 'ok')
  })
})

describe('resolveWalletLpPositions: Aerodrome burned-position revert', () => {
  it('"execution reverted: ID" (Slipstream) counts as burned, so older positions are checked', async () => {
    const keys = new Set<string>()
    const transfers = Array.from({ length: 35 }, (_, k) => {
      const i = k + 1
      const hash = `0x${i.toString(16).padStart(64, '0')}`
      keys.add(`base:${hash}`)
      return { hash, erc721TokenId: `0x${i.toString(16)}`, blockNum: `0x${i.toString(16)}` }
    })
    const tick = Math.round(Math.log(2500 * 1e-12) / Math.log(1.0001))
    const rpc = async (body: unknown) => {
      if (Array.isArray(body)) {
        const reqs = body as Array<{ id: number; params: [{ to: string; data: string }] }>
        return reqs.map((r) => {
          if (r.params[0].data === '0x313ce567') return { id: r.id, result: `0x${w(r.params[0].to === WETH ? 18 : 6)}` }
          const id = Number(BigInt(`0x${r.params[0].data.slice(10)}`))
          return id === 2
            ? { id: r.id, result: positionsHex({ token0: WETH, token1: USDC, tickLower: tick - 600, tickUpper: tick + 600, liquidity: BigInt(1e15) }) }
            : { id: r.id, error: { code: 3, message: 'execution reverted: ID' } }
        })
      }
      const req = body as { params: [{ toAddress: string; contractAddresses: string[] }] }
      return { result: { transfers: req.params[0].toAddress === ZAPPER && req.params[0].contractAddresses[0] === SLIPSTREAM ? transfers : [] } }
    }
    const r = await resolveWalletLpPositions({
      walletAddress: WALLET, liquidityTxKeys: keys, counterparties: [ZAPPER], rpc,
      priceUsd: (t) => (t === WETH ? 2500 : t === USDC ? 1 : null),
    })
    assert.equal(r.positionReadErrors, 0)
    assert.equal(r.burnedPositions, 34)
    assert.equal(r.openPositions, 1)
    assert.equal(r.positions[0].tokenId, '2')
    assert.equal(r.status, 'ok')
  })
})
