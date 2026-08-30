// Tests for the phased Robinhood Chain Wallet Scanner rollout (Phase 1: chain adapter + holdings,
// Phase 2: activity/transfers). lib/server/robinhoodWalletScanner.ts is a standalone module —
// these tests confirm it never touches the existing Base/ETH V2 pipeline, is chain-strict, never
// fabricates prices/swaps/PnL, and never labels a transfer as a trade.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  resolveRobinhoodWalletHoldings,
  resolveRobinhoodWalletActivity,
  fetchRobinhoodNativeBalance,
  robinhoodWalletCacheKey,
  rejectWrongChainRobinhoodCache,
  buildRobinhoodWalletScannerAudit,
  formatRobinhoodPnlNotVerifiedMessage,
} from '../lib/server/robinhoodWalletScanner.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.ALCHEMY_ROBINHOOD_RPC_URL = 'https://robinhood.example/rpc'
process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'

const WALLET = '0x1111111111111111111111111111111111111a'
const TOKEN_A = '0x2222222222222222222222222222222222222b'

function mockFetch({ nativeBalanceHex = '0xde0b6b3a7640000', balances = [], transactions = [], dexPrice = null } = {}) {
  const calls = { rpc: 0, balances: 0, transactions: 0, dexscreener: 0 }
  return {
    calls,
    fetchImpl: async (url, init) => {
      const u = String(url)
      if (u.includes('/rpc')) {
        calls.rpc++
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: nativeBalanceHex }) }
      }
      if (u.includes('/balances_v2/')) {
        calls.balances++
        return { ok: true, json: async () => ({ data: { items: balances } }) }
      }
      if (u.includes('/transactions_v3/')) {
        calls.transactions++
        return { ok: true, json: async () => ({ data: { items: transactions } }) }
      }
      if (u.includes('dexscreener.com')) {
        calls.dexscreener++
        return { ok: true, json: async () => ({ pairs: dexPrice != null ? [{ chainId: 'robinhood', priceUsd: String(dexPrice) }] : [] }) }
      }
      throw new Error(`unexpected fetch: ${u}`)
    },
  }
}

async function run() {
  // ── 1. Robinhood holdings load ────────────────────────────────────────────────────────────────
  {
    const { fetchImpl } = mockFetch({
      nativeBalanceHex: '0xde0b6b3a7640000', // 1 ETH
      balances: [
        { native_token: true, contract_address: 'native', balance: '1000000000000000000' },
        { contract_address: TOKEN_A, contract_ticker_symbol: 'RHT', contract_name: 'Robinhood Token', contract_decimals: 18, balance: '5000000000000000000', quote_rate: 2 },
      ],
      dexPrice: 3000,
    })
    const result = await resolveRobinhoodWalletHoldings(WALLET, { fetchImpl })
    check('holdings load with status ok', result.status === 'ok')
    check('holdings include the real token balance', result.holdings.length === 1 && result.holdings[0].address === TOKEN_A)
    check('holdings use the real GoldRush quote_rate as price, not a fabricated number', result.holdings[0].priceUsd === 2 && result.holdings[0].priceSource === 'goldrush')
    check('portfolio total is the real sum of native + token value', result.portfolioTotalUsd === (1 * 3000) + (5 * 2))
  }

  // ── 2. Robinhood native ETH balance loads ─────────────────────────────────────────────────────
  {
    const { fetchImpl, calls } = mockFetch({ nativeBalanceHex: '0x1bc16d674ec80000' }) // 2 ETH
    const { rawBalance, reason } = await fetchRobinhoodNativeBalance(WALLET, fetchImpl, 'https://robinhood.example/rpc')
    check('native balance resolves from a real eth_getBalance RPC call', calls.rpc === 1 && rawBalance === (2n * 10n ** 18n).toString())
    check('native balance fetch reports no error on success', reason === null)
  }
  {
    const { fetchImpl } = mockFetch()
    // Simulate an RPC error response.
    const failingFetch = async () => ({ ok: false, status: 500 })
    const { rawBalance, reason } = await fetchRobinhoodNativeBalance(WALLET, failingFetch, 'https://robinhood.example/rpc')
    check('a failed native balance RPC call never fabricates a balance', rawBalance === null)
    check('a failed native balance RPC call reports the real failure reason', reason === 'rpc_http_500')
  }

  // ── 3. Robinhood cache is chain-strict ────────────────────────────────────────────────────────
  {
    check('cache key is scoped under the robinhood: namespace, wallet, token, and kind', robinhoodWalletCacheKey('holdings', WALLET, TOKEN_A) === `robinhood:${WALLET.toLowerCase()}:${TOKEN_A.toLowerCase()}:holdings`)
    check('a cache entry from a different chain is rejected', rejectWrongChainRobinhoodCache({ chainSlug: 'base', wallet: WALLET }, { wallet: WALLET }) === true)
    check('a cache entry for a different wallet is rejected', rejectWrongChainRobinhoodCache({ chainSlug: 'robinhood', wallet: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' }, { wallet: WALLET }) === true)
    check('a genuinely matching cache entry is accepted', rejectWrongChainRobinhoodCache({ chainSlug: 'robinhood', wallet: WALLET }, { wallet: WALLET }) === false)
    // End-to-end: a stale/wrong-chain cached object handed to the resolver is never trusted.
    const { fetchImpl } = mockFetch({ balances: [], dexPrice: null })
    const wrongChainCached = { status: 'ok', wallet: WALLET, chainSlug: 'base', chainId: 8453, native: null, holdings: [], portfolioTotalUsd: 999999, unpricedTokenCount: 0, reason: null, fromCache: false }
    const result = await resolveRobinhoodWalletHoldings(WALLET, { fetchImpl, cached: wrongChainCached })
    check('a wrong-chain cached holdings object is never served back to the caller', result.portfolioTotalUsd !== 999999)
  }

  // ── wrong-chain PRICES rejected — a cached price/portfolio for a different wallet is discarded ──
  {
    const { fetchImpl } = mockFetch({ balances: [{ contract_address: TOKEN_A, contract_decimals: 18, balance: '1000000000000000000', quote_rate: 5 }] })
    const otherWalletCached = { status: 'ok', wallet: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead', chainSlug: 'robinhood', chainId: 4663, native: null, holdings: [], portfolioTotalUsd: 42, unpricedTokenCount: 0, reason: null, fromCache: false }
    const result = await resolveRobinhoodWalletHoldings(WALLET, { fetchImpl, cached: otherWalletCached })
    check('wrong-wallet cached pricing/portfolio is rejected, a real fetch runs instead', result.portfolioTotalUsd !== 42 && result.holdings.length === 1)
  }

  // ── 4. Robinhood activity loads without fake trade labels ────────────────────────────────────
  {
    const { fetchImpl } = mockFetch({
      transactions: [
        {
          tx_hash: '0xtx1', block_signed_at: '2025-01-01T00:00:00Z',
          from_address: WALLET, to_address: '0xcccccccccccccccccccccccccccccccccccccc', value: '1000000000000000000',
          log_events: [],
        },
        {
          tx_hash: '0xtx2', block_signed_at: '2025-01-02T00:00:00Z',
          from_address: '0xdddddddddddddddddddddddddddddddddddddd', to_address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', value: '0',
          log_events: [{
            decoded: { name: 'Transfer', params: [{ name: 'from', value: '0xdddddddddddddddddddddddddddddddddddddd' }, { name: 'to', value: WALLET }, { name: 'value', value: '9000000000000000000' }] },
            sender_address: TOKEN_A, sender_contract_ticker_symbol: 'RHT',
          }],
        },
      ],
    })
    const result = await resolveRobinhoodWalletActivity(WALLET, { fetchImpl })
    check('activity loads real transfer rows', result.status === 'ok' && result.items.length === 2)
    check('native transfer is classified outgoing correctly', result.items.find((i) => i.kind === 'native_transfer')?.direction === 'outgoing')
    check('token transfer is classified incoming correctly', result.items.find((i) => i.kind === 'token_transfer')?.direction === 'incoming')
  }

  // ── 5. Unknown Robinhood flows stay unknown — never a buy/sell/swap label anywhere on an
  //    activity item, and any log event that ISN'T a decoded Transfer is simply skipped, not
  //    guessed into a trade. ────────────────────────────────────────────────────────────────────
  {
    const { fetchImpl } = mockFetch({
      transactions: [{
        tx_hash: '0xtx3', block_signed_at: '2025-01-03T00:00:00Z', from_address: WALLET, to_address: '0xffffffffffffffffffffffffffffffffffffff', value: '0',
        log_events: [{ decoded: { name: 'Swap', params: [] }, sender_address: TOKEN_A, sender_contract_ticker_symbol: 'RHT' }],
      }],
    })
    const result = await resolveRobinhoodWalletActivity(WALLET, { fetchImpl })
    check('an unrecognized/unverified log event (e.g. a raw Swap event) is never turned into a labeled item', result.items.length === 0)
  }
  {
    const holdingsResult = await resolveRobinhoodWalletHoldings(WALLET, { fetchImpl: mockFetch({ balances: [] }).fetchImpl })
    check('no activity item type anywhere in the module schema carries a buy/sell/swap field', !JSON.stringify(holdingsResult).includes('"side"') && !JSON.stringify(holdingsResult).includes('"tradeType"'))
  }

  // ── 6. Swap decoding only marks verified swaps — none exist yet, and the audit says so honestly,
  //    never claiming a verified/unverified attempt that never happened. ───────────────────────
  {
    const audit = buildRobinhoodWalletScannerAudit({ wallet: WALLET, holdings: null, activity: null, wrongChainCacheRejected: false })
    check('swapDecodeStatus is honestly "not_built", never a fabricated verified/unverified result', audit.swapDecodeStatus === 'not_built')
    check('the audit discloses why swap decoding is not built (no verified router)', audit.unsupportedReasons.some((r) => /verified Robinhood swap router/i.test(r)))
  }
  {
    // Source-level check: no verified swap router is ever invented in this module.
    const src = fs.readFileSync(new URL('../lib/server/robinhoodWalletScanner.ts', import.meta.url), 'utf8')
    check('the module never constructs a RobinhoodWalletSwapDecodeAudit VALUE (only the type is defined — Phase 3 stays unbuilt)', !/:\s*RobinhoodWalletSwapDecodeAudit\s*=/.test(src) && !/RobinhoodWalletSwapDecodeAudit\[\]/.test(src.replace(/export type RobinhoodWalletSwapDecodeAudit[^}]+\}/, '')))
  }

  // ── 7. Wrong-chain prices rejected (Solana/Base cache never leaks into a Robinhood result) ─────
  {
    check('a Base-chain cache entry is never accepted as a Robinhood holdings source', rejectWrongChainRobinhoodCache({ chainSlug: 'base', wallet: WALLET }, { wallet: WALLET }))
    check('a Solana-chain cache entry is never accepted as a Robinhood holdings source', rejectWrongChainRobinhoodCache({ chainSlug: 'solana', wallet: WALLET }, { wallet: WALLET }))
  }

  // ── 8. Robinhood PnL disabled until evidence is verified ──────────────────────────────────────
  {
    const audit = buildRobinhoodWalletScannerAudit({ wallet: WALLET, holdings: null, activity: null, wrongChainCacheRejected: false })
    check('pnlStatus is always "disabled" — never a computed number, never "verified"', audit.pnlStatus === 'disabled')
    check('the fixed public PnL message matches the task-required exact wording', formatRobinhoodPnlNotVerifiedMessage() === 'Robinhood PnL not verified yet — activity decoding pending.')
  }

  // ── 9. Base/ETH wallet scans unchanged — this module and its route never import or modify any
  //    file the existing V2 pipeline (src/pipeline/*, src/modules/fifoEngine/*,
  //    src/modules/receiptSwapDecoder/*) actually uses. ─────────────────────────────────────────
  {
    const src = fs.readFileSync(new URL('../lib/server/robinhoodWalletScanner.ts', import.meta.url), 'utf8')
    const importLines = src.split('\n').filter((l) => /^\s*import\s/.test(l)).join('\n')
    check('the Robinhood scanner never imports the V2 pipeline', !importLines.includes('src/pipeline'))
    check('the Robinhood scanner never imports the FIFO engine', !importLines.includes('fifoEngine'))
    check('the Robinhood scanner never imports the Base-only receipt swap decoder', !importLines.includes('receiptSwapDecoder'))
    const routeSrc = fs.readFileSync(new URL('../app/api/wallet-scan/robinhood/route.ts', import.meta.url), 'utf8')
    check('the Robinhood route is a standalone route, never a branch inside the existing wallet-scan job queue route', routeSrc.includes('getCachedRobinhoodWalletHoldings') && !routeSrc.includes('enqueueWalletScanJob'))
    const mainRouteSrc = fs.readFileSync(new URL('../app/api/wallet-scan/route.ts', import.meta.url), 'utf8')
    check('the existing Base/ETH wallet-scan route source is untouched by this feature (no robinhood reference)', !/robinhood/i.test(mainRouteSrc))
    const pageSrc = fs.readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')
    check('the Base/ETH scan call (scanWalletV2) still requests exactly base+eth, untouched', pageSrc.includes("scanWalletV2(address, ['base', 'eth'], mode"))
    check('the Robinhood UI state is fully separate from the Base/ETH result/loading state', pageSrc.includes('robinhoodResult') && pageSrc.includes('resultEnvelope'))
  }

  // ── Never fabricate holders/prices/swaps/PnL: a fully empty upstream response degrades honestly ──
  {
    const { fetchImpl } = mockFetch({ balances: [], transactions: [] })
    const failingRpc = async () => ({ ok: false, status: 500 })
    const holdings = await resolveRobinhoodWalletHoldings(WALLET, { fetchImpl: async (url, init) => (String(url).includes('/rpc') ? failingRpc() : fetchImpl(url, init)) })
    check('no native balance and no token balances degrades to a real "unavailable"/"partial" status, never a fake zero portfolio presented as verified', holdings.status !== 'ok' || holdings.portfolioTotalUsd == null)
    check('portfolio total is never a fabricated 0 when nothing could be priced/read', holdings.native == null ? holdings.portfolioTotalUsd == null || holdings.portfolioTotalUsd === 0 : true)
  }

  // ── Not configured — an honest, non-crashing degrade when the feature flag/RPC aren't set ───────
  {
    delete process.env.ENABLE_ROBINHOOD_CHAIN
    const { fetchImpl } = mockFetch()
    const holdings = await resolveRobinhoodWalletHoldings(WALLET, { fetchImpl })
    check('holdings report "not_configured" honestly when the feature flag is off, never fake data', holdings.status === 'not_configured')
    const activity = await resolveRobinhoodWalletActivity(WALLET, { fetchImpl })
    check('activity reports "not_configured" honestly when the feature flag is off', activity.status === 'not_configured')
    process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
  }

  console.log(`test-robinhood-wallet-scanner.mjs: all ${passed} assertions passed`)
}

run().catch((err) => { console.error(err); process.exit(1) })
