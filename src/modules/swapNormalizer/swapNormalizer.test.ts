// Tests for src/modules/swapNormalizer/*. Uses node:test, same convention as
// src/modules/tradeLedger.test.ts. NOT wired into npm test (which runs a single hardcoded file,
// tests/auth-flow.test.js) — package.json intentionally not modified, out of scope for this task,
// same reasoning as tradeLedger.test.ts. Run directly with:
//   npx tsx --test src/modules/swapNormalizer/swapNormalizer.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTrades } from './index'
import type { RawTransfer, RawTxBundle } from './types'
import { classifyTransfer } from './transferClassifier'
import { detectBuySell } from './buySellDetector'
import { detectRouterType } from './routers'

const WALLET = '0xWALLET000000000000000000000000000000001'
const ROUTER = '0xROUTER00000000000000000000000000000002'
const POOL1 = '0xPOOL100000000000000000000000000000003'
const POOL2 = '0xPOOL200000000000000000000000000000004'
const USDC = '0xUSDC00000000000000000000000000000000AA'
const DEGEN = '0xDEGEN0000000000000000000000000000000BB'
const WETH = '0xWETH00000000000000000000000000000000CC'
const LP = '0xLPTOKEN000000000000000000000000000000DD'
const ZERO = '0x0000000000000000000000000000000000000000'
const UNISWAP_V3_SWAPROUTER02_BASE = '0x2626664c2603336E57B271c5C0b26F421741e481'

function transfer(overrides: Partial<RawTransfer>): RawTransfer {
  return {
    logIndex: 0,
    contract: USDC,
    symbol: 'USDC',
    decimals: 6,
    from: '',
    to: '',
    amountRaw: '100000000',
    ...overrides,
  }
}

describe('swapNormalizer — single-hop swap (direct transfer, no router)', () => {
  it('resolves a direct wallet<->pool swap and classifies BUY (USDC -> DEGEN)', () => {
    const tx: RawTxBundle = {
      chain: 'base',
      txHash: '0x1',
      timestamp: 1000,
      transfers: [
        transfer({ logIndex: 1, contract: USDC, symbol: 'USDC', decimals: 6, from: WALLET, to: POOL1, amountRaw: '100000000' }),
        transfer({ logIndex: 2, contract: DEGEN, symbol: 'DEGEN', decimals: 18, from: POOL1, to: WALLET, amountRaw: '1000000000000000000000' }),
      ],
    }
    const [trade] = normalizeTrades([tx], WALLET)
    assert.ok(trade)
    assert.equal(trade.type, 'BUY')
    assert.equal(trade.isBuy, true)
    assert.equal(trade.isSell, false)
    assert.equal(trade.tokenIn.symbol, 'USDC')
    assert.equal(trade.tokenOut.symbol, 'DEGEN')
    assert.equal(trade.amountIn, 100)
    assert.equal(trade.amountOut, 1000)
    assert.equal(trade.meta.hops, 1)
    assert.equal(trade.meta.missingSide, 'none')
    assert.equal(trade.wallet, WALLET.toLowerCase())
    assert.equal(trade.chain, 'base')
  })
})

describe('swapNormalizer — multi-hop swap (router -> pool1 -> pool2 -> router -> wallet)', () => {
  it('collapses a 5-transfer multi-hop path into one trade with hops > 1', () => {
    const tx: RawTxBundle = {
      chain: 'base',
      txHash: '0x2',
      timestamp: 2000,
      router: ROUTER,
      transfers: [
        transfer({ logIndex: 1, contract: USDC, symbol: 'USDC', decimals: 6, from: WALLET, to: ROUTER, amountRaw: '500000000' }),
        transfer({ logIndex: 2, contract: USDC, symbol: 'USDC', decimals: 6, from: ROUTER, to: POOL1, amountRaw: '500000000' }),
        transfer({ logIndex: 3, contract: WETH, symbol: 'WETH', decimals: 18, from: POOL1, to: POOL2, amountRaw: '200000000000000000' }),
        transfer({ logIndex: 4, contract: DEGEN, symbol: 'DEGEN', decimals: 18, from: POOL2, to: ROUTER, amountRaw: '5000000000000000000000' }),
        transfer({ logIndex: 5, contract: DEGEN, symbol: 'DEGEN', decimals: 18, from: ROUTER, to: WALLET, amountRaw: '5000000000000000000000' }),
      ],
    }
    const [trade] = normalizeTrades([tx], WALLET)
    assert.ok(trade)
    assert.equal(trade.type, 'BUY')
    assert.equal(trade.tokenIn.symbol, 'USDC')
    assert.equal(trade.tokenOut.symbol, 'DEGEN')
    assert.equal(trade.amountIn, 500)
    assert.equal(trade.amountOut, 5000)
    assert.equal(trade.meta.hops, 4) // 3 internal pool-to-pool/router legs + 1
    assert.equal(trade.router, ROUTER.toLowerCase())
  })
})

describe('swapNormalizer — LP_ADD (dual-token supply + LP mint)', () => {
  it('detects LP_ADD from an explicit LP-token mint plus an underlying token transfer', () => {
    const tx: RawTxBundle = {
      chain: 'base',
      txHash: '0x3',
      timestamp: 3000,
      router: ROUTER,
      poolMetadata: [{ poolAddress: POOL1, lpTokenAddress: LP, token0: USDC, token1: WETH }],
      transfers: [
        transfer({ logIndex: 1, contract: USDC, symbol: 'USDC', decimals: 6, from: WALLET, to: POOL1, amountRaw: '1000000000' }),
        transfer({ logIndex: 2, contract: WETH, symbol: 'WETH', decimals: 18, from: WALLET, to: POOL1, amountRaw: '400000000000000000' }),
        transfer({ logIndex: 3, contract: LP, symbol: 'LP', decimals: 18, from: ZERO, to: WALLET, amountRaw: '1000000000000000000' }),
      ],
    }
    const [trade] = normalizeTrades([tx], WALLET)
    assert.ok(trade)
    assert.equal(trade.type, 'LP_ADD')
    assert.equal(trade.tokenIn.symbol, 'USDC')
    assert.equal(trade.tokenOut.symbol, 'LP')
    assert.equal(trade.amountOut, 1)
    assert.equal(trade.isBuy, false)
    assert.equal(trade.isSell, false)
  })
})

describe('swapNormalizer — LP_REMOVE (LP burn + underlying token received)', () => {
  it('detects LP_REMOVE from an explicit LP-token burn plus an underlying token transfer', () => {
    const tx: RawTxBundle = {
      chain: 'base',
      txHash: '0x4',
      timestamp: 4000,
      poolMetadata: [{ poolAddress: POOL1, lpTokenAddress: LP, token0: USDC, token1: WETH }],
      transfers: [
        transfer({ logIndex: 1, contract: LP, symbol: 'LP', decimals: 18, from: WALLET, to: ZERO, amountRaw: '1000000000000000000' }),
        transfer({ logIndex: 2, contract: USDC, symbol: 'USDC', decimals: 6, from: POOL1, to: WALLET, amountRaw: '1000000000' }),
      ],
    }
    const [trade] = normalizeTrades([tx], WALLET)
    assert.ok(trade)
    assert.equal(trade.type, 'LP_REMOVE')
    assert.equal(trade.tokenIn.symbol, 'LP')
    assert.equal(trade.tokenOut.symbol, 'USDC')
    assert.equal(trade.amountIn, 1)
  })
})

describe('swapNormalizer — internal transfers (wallet not involved)', () => {
  it('produces no trade for a tx where every transfer is internal to other addresses', () => {
    const tx: RawTxBundle = {
      chain: 'base',
      txHash: '0x5',
      timestamp: 5000,
      transfers: [transfer({ logIndex: 1, contract: USDC, from: POOL1, to: POOL2, amountRaw: '100000000' })],
    }
    const trades = normalizeTrades([tx], WALLET)
    assert.deepEqual(trades, [])
  })
})

describe('transferClassifier — all five classes', () => {
  it('classifies TRANSFER_IN, TRANSFER_OUT, INTERNAL, ROUTER_IN, ROUTER_OUT correctly', () => {
    assert.equal(classifyTransfer(transfer({ from: POOL1, to: WALLET }), WALLET), 'TRANSFER_IN')
    assert.equal(classifyTransfer(transfer({ from: WALLET, to: POOL1 }), WALLET), 'TRANSFER_OUT')
    assert.equal(classifyTransfer(transfer({ from: POOL1, to: POOL2 }), WALLET), 'INTERNAL')
    assert.equal(classifyTransfer(transfer({ from: WALLET, to: ROUTER }), WALLET, ROUTER), 'ROUTER_IN')
    assert.equal(classifyTransfer(transfer({ from: ROUTER, to: WALLET }), WALLET, ROUTER), 'ROUTER_OUT')
  })
})

describe('swapNormalizer — router-based swap detects a known router type', () => {
  it('tags meta.routerType with the real Uniswap V3 SwapRouter02 address on base', () => {
    const tx: RawTxBundle = {
      chain: 'base',
      txHash: '0x6',
      timestamp: 6000,
      router: UNISWAP_V3_SWAPROUTER02_BASE,
      transfers: [
        transfer({ logIndex: 1, contract: USDC, symbol: 'USDC', decimals: 6, from: WALLET, to: UNISWAP_V3_SWAPROUTER02_BASE, amountRaw: '100000000' }),
        transfer({ logIndex: 2, contract: DEGEN, symbol: 'DEGEN', decimals: 18, from: UNISWAP_V3_SWAPROUTER02_BASE, to: WALLET, amountRaw: '1000000000000000000000' }),
      ],
    }
    const [trade] = normalizeTrades([tx], WALLET)
    assert.equal(trade.meta.routerType, 'UNISWAP_V3')
  })

  it('detectRouterType returns null for an unrecognized address', () => {
    assert.equal(detectRouterType('base', '0xnotarouter'), null)
  })
})

describe('buySellDetector — direct unit tests', () => {
  const usdc = { address: USDC, symbol: 'USDC', decimals: 6 }
  const degen = { address: DEGEN, symbol: 'DEGEN', decimals: 18 }
  const brett = { address: '0xbrett', symbol: 'BRETT', decimals: 18 }

  it('quote -> non-quote is BUY', () => {
    const r = detectBuySell('base', usdc, degen, 'none')
    assert.equal(r.type, 'BUY')
    assert.equal(r.isBuy, true)
    assert.equal(r.isSell, false)
  })

  it('non-quote -> quote is SELL', () => {
    const r = detectBuySell('base', degen, usdc, 'none')
    assert.equal(r.type, 'SELL')
    assert.equal(r.isSell, true)
  })

  it('non-quote -> non-quote is generic SWAP', () => {
    const r = detectBuySell('base', degen, brett, 'none')
    assert.equal(r.type, 'SWAP')
    assert.equal(r.isBuy, false)
    assert.equal(r.isSell, false)
  })

  it('missing tokenOut with a quote-asset tokenIn is a best-effort BUY', () => {
    const r = detectBuySell('base', usdc, { address: '', symbol: 'UNKNOWN', decimals: 18 }, 'tokenOut')
    assert.equal(r.type, 'BUY')
  })

  it('missing tokenIn with a quote-asset tokenOut is a best-effort SELL', () => {
    const r = detectBuySell('base', { address: '', symbol: 'UNKNOWN', decimals: 18 }, usdc, 'tokenIn')
    assert.equal(r.type, 'SELL')
  })
})

describe('normalizeTrades — determinism and dedupe', () => {
  it('returns an empty array for empty input, never throws', () => {
    assert.deepEqual(normalizeTrades([], WALLET), [])
  })

  it('dedupes an identical chain+txHash bundle passed twice', () => {
    const tx: RawTxBundle = {
      chain: 'base',
      txHash: '0x7',
      timestamp: 7000,
      transfers: [
        transfer({ logIndex: 1, contract: USDC, from: WALLET, to: POOL1, amountRaw: '100000000' }),
        transfer({ logIndex: 2, contract: DEGEN, symbol: 'DEGEN', decimals: 18, from: POOL1, to: WALLET, amountRaw: '1000000000000000000000' }),
      ],
    }
    const trades = normalizeTrades([tx, tx], WALLET)
    assert.equal(trades.length, 1)
  })

  it('sorts output ascending by timestamp regardless of input order', () => {
    const mk = (txHash: string, timestamp: number): RawTxBundle => ({
      chain: 'eth',
      txHash,
      timestamp,
      transfers: [
        transfer({ logIndex: 1, contract: USDC, from: WALLET, to: POOL1, amountRaw: '100000000' }),
        transfer({ logIndex: 2, contract: DEGEN, symbol: 'DEGEN', decimals: 18, from: POOL1, to: WALLET, amountRaw: '1000000000000000000' }),
      ],
    })
    const trades = normalizeTrades([mk('0xc', 3000), mk('0xa', 1000), mk('0xb', 2000)], WALLET)
    assert.deepEqual(trades.map((t) => t.timestamp), [1000, 2000, 3000])
  })

  it('keeps trades on different chains independent even if txHash strings coincide', () => {
    const mk = (chain: 'base' | 'arbitrum'): RawTxBundle => ({
      chain,
      txHash: '0xsame',
      timestamp: 1000,
      transfers: [
        transfer({ logIndex: 1, contract: USDC, from: WALLET, to: POOL1, amountRaw: '100000000' }),
        transfer({ logIndex: 2, contract: DEGEN, symbol: 'DEGEN', decimals: 18, from: POOL1, to: WALLET, amountRaw: '1000000000000000000' }),
      ],
    })
    const trades = normalizeTrades([mk('base'), mk('arbitrum')], WALLET)
    assert.equal(trades.length, 2)
    assert.deepEqual(trades.map((t) => t.chain).sort(), ['arbitrum', 'base'])
  })
})

describe('swapNormalizer — missing one side of the swap (Covalent miss)', () => {
  it('still produces a best-effort BUY when only the wallet-outgoing (quote-asset) leg is present', () => {
    const tx: RawTxBundle = {
      chain: 'base',
      txHash: '0x8',
      timestamp: 8000,
      transfers: [transfer({ logIndex: 1, contract: USDC, symbol: 'USDC', decimals: 6, from: WALLET, to: POOL1, amountRaw: '100000000' })],
    }
    const [trade] = normalizeTrades([tx], WALLET)
    assert.ok(trade)
    assert.equal(trade.type, 'BUY')
    assert.equal(trade.meta.missingSide, 'tokenOut')
    assert.equal(trade.tokenOut.symbol, 'UNKNOWN')
    assert.equal(trade.amountOut, 0)
  })

  it('still produces a best-effort SELL when only the wallet-incoming (quote-asset) leg is present', () => {
    const tx: RawTxBundle = {
      chain: 'base',
      txHash: '0x9',
      timestamp: 9000,
      transfers: [transfer({ logIndex: 1, contract: USDC, symbol: 'USDC', decimals: 6, from: POOL1, to: WALLET, amountRaw: '100000000' })],
    }
    const [trade] = normalizeTrades([tx], WALLET)
    assert.ok(trade)
    assert.equal(trade.type, 'SELL')
    assert.equal(trade.meta.missingSide, 'tokenIn')
    assert.equal(trade.tokenIn.symbol, 'UNKNOWN')
  })
})
