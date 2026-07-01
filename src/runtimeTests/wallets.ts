// Runtime test harness — wallet test configurations.
//
// Each config drives one end-to-end pipeline run. Wallets WITHOUT `syntheticRawEvents` run the
// real production pipeline (runWalletScan) exactly as it will run in production — including real
// (or naturally-absent, if no provider API keys are configured in this environment) network
// calls, which is itself a legitimate exercise of the provider_unavailable fallback path.
//
// Wallets WITH `syntheticRawEvents` exist because several scenarios (dust-only, malformed events,
// guaranteed recovery triggers, extreme volume) need to be deterministic and CI-safe — they can't
// depend on what a real wallet happens to contain at test time. These still run every pipeline
// stage from normalization onward via the exact same module functions runWalletScan uses (see
// utils.ts `runPipelineForWallet`); only the network-fetch stage is substituted.

import type { ProviderStatus, RawProviderEvent, SupportedChain } from '../modules/providerFetchWindow/types'
import type { ScanModeInput } from '../pipeline/types'

export type WalletTestConfig = {
  name: string
  walletAddress: string
  chains: string[]
  scanMode: ScanModeInput
  syntheticRawEvents?: RawProviderEvent[]
  // Test-harness-only extension beyond the literal spec: lets a test deterministically force a
  // chain's providerStatus (e.g. provider_unavailable) without depending on live network
  // conditions or the presence/absence of real API keys in the test environment.
  forcedProviderStatusByChain?: Partial<Record<SupportedChain, ProviderStatus>>
}

const WALLET_A = '0x30ec8aea2ab3d5000da703912193294a81430cc8'
const WALLET_B = '0x1111111111111111111111111111111111111111'
const WALLET_C = '0x2222222222222222222222222222222222222222'
const WALLET_D = '0x3333333333333333333333333333333333333333'
const WALLET_E = '0x4444444444444444444444444444444444444444'
const WALLET_F = '0x5555555555555555555555555555555555555555'
const WALLET_G = '0x6666666666666666666666666666666666666666'
const WALLET_H = '0x7777777777777777777777777777777777777777'
const WALLET_I = '0x8888888888888888888888888888888888888888'
const WALLET_J = '0x9999999999999999999999999999999999999999'

function isoMinusDays(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

function buyEvent(overrides: Partial<RawProviderEvent> & { chain: SupportedChain; wallet: string }): RawProviderEvent {
  const { wallet, ...eventOverrides } = overrides
  return {
    provider: 'goldrush',
    txHash: `0x${Math.random().toString(16).slice(2).padEnd(64, '0')}`,
    timestamp: isoMinusDays(5),
    fromAddress: '0xrouter00000000000000000000000000000000',
    toAddress: wallet,
    contract: '0xaaaa000000000000000000000000000000000a',
    symbol: 'AAA',
    amountRaw: '1000000000000000000',
    tokenDecimals: 18,
    ...eventOverrides,
  }
}

function sellEvent(overrides: Partial<RawProviderEvent> & { chain: SupportedChain; wallet: string }): RawProviderEvent {
  const { wallet, ...eventOverrides } = overrides
  return {
    provider: 'goldrush',
    txHash: `0x${Math.random().toString(16).slice(2).padEnd(64, '0')}`,
    timestamp: isoMinusDays(3),
    fromAddress: wallet,
    toAddress: '0xrouter00000000000000000000000000000000',
    contract: '0xaaaa000000000000000000000000000000000a',
    symbol: 'AAA',
    amountRaw: '500000000000000000',
    tokenDecimals: 18,
    ...eventOverrides,
  }
}

// ── 1. simpleWallet — real pipeline, single chain, normal mode ──────────────────────────────
const simpleWallet: WalletTestConfig = {
  name: 'simpleWallet',
  walletAddress: WALLET_A,
  chains: ['base'],
  scanMode: 'normal',
}

// ── 2. multiChainWallet — real pipeline, multiple chains, deep mode ─────────────────────────
const multiChainWallet: WalletTestConfig = {
  name: 'multiChainWallet',
  walletAddress: WALLET_B,
  chains: ['base', 'eth'],
  scanMode: 'deep',
}

// ── 3. highValueWallet — synthetic, guaranteed high-value buys, deep mode ───────────────────
const highValueWallet: WalletTestConfig = {
  name: 'highValueWallet',
  walletAddress: WALLET_C,
  chains: ['base'],
  scanMode: 'deep',
  syntheticRawEvents: [
    buyEvent({ chain: 'base', wallet: WALLET_C, contract: '0xhighvalue000000000000000000000000000001', symbol: 'HVT', amountRaw: '2000000000000000000000', timestamp: isoMinusDays(10) }),
    sellEvent({ chain: 'base', wallet: WALLET_C, contract: '0xhighvalue000000000000000000000000000001', symbol: 'HVT', amountRaw: '500000000000000000000', timestamp: isoMinusDays(2) }),
  ],
}

// ── 4. dustOnlyWallet — synthetic, negligible activity, every chain should end up dust ──────
const dustOnlyWallet: WalletTestConfig = {
  name: 'dustOnlyWallet',
  walletAddress: WALLET_D,
  chains: ['base', 'eth'],
  scanMode: 'normal',
  syntheticRawEvents: [
    buyEvent({ chain: 'base', wallet: WALLET_D, contract: '0xdust000000000000000000000000000000dust', symbol: 'DUST', amountRaw: '1', tokenDecimals: 18 }),
  ],
}

// ── 5. providerUnavailableWallet — forced provider_unavailable on every requested chain ─────
const providerUnavailableWallet: WalletTestConfig = {
  name: 'providerUnavailableWallet',
  walletAddress: WALLET_E,
  chains: ['base', 'eth'],
  scanMode: 'normal',
  syntheticRawEvents: [],
  forcedProviderStatusByChain: { base: 'provider_unavailable', eth: 'provider_unavailable' },
}

// ── 6. recoveryTriggeredWallet — synthetic, repeated sells to guarantee a trigger ───────────
const recoveryTriggeredWallet: WalletTestConfig = {
  name: 'recoveryTriggeredWallet',
  walletAddress: WALLET_F,
  chains: ['base'],
  scanMode: 'deep',
  syntheticRawEvents: [
    buyEvent({ chain: 'base', wallet: WALLET_F, contract: '0xrepeat0000000000000000000000000000rept', symbol: 'RPT', timestamp: isoMinusDays(20) }),
    sellEvent({ chain: 'base', wallet: WALLET_F, contract: '0xrepeat0000000000000000000000000000rept', symbol: 'RPT', timestamp: isoMinusDays(15) }),
    buyEvent({ chain: 'base', wallet: WALLET_F, contract: '0xrepeat0000000000000000000000000000rept', symbol: 'RPT', timestamp: isoMinusDays(12) }),
    sellEvent({ chain: 'base', wallet: WALLET_F, contract: '0xrepeat0000000000000000000000000000rept', symbol: 'RPT', timestamp: isoMinusDays(8) }),
  ],
}

// ── 7. noRecoveryWallet — synthetic, small activity, no trigger should fire ─────────────────
const noRecoveryWallet: WalletTestConfig = {
  name: 'noRecoveryWallet',
  walletAddress: WALLET_G,
  chains: ['base'],
  scanMode: 'deep',
  syntheticRawEvents: [
    buyEvent({ chain: 'base', wallet: WALLET_G, contract: '0xsmall00000000000000000000000000000small', symbol: 'SML', amountRaw: '1000000000000000', timestamp: isoMinusDays(6) }),
  ],
}

// ── 8. malformedEventsWallet — synthetic, several intentionally-broken raw events ───────────
const malformedEventsWallet: WalletTestConfig = {
  name: 'malformedEventsWallet',
  walletAddress: WALLET_H,
  chains: ['base'],
  scanMode: 'normal',
  syntheticRawEvents: [
    buyEvent({ chain: 'base', wallet: WALLET_H }), // one valid event, so normalization has something to succeed on
    { provider: 'goldrush', chain: 'base', txHash: null, timestamp: isoMinusDays(4), fromAddress: '0xrouter00000000000000000000000000000000', toAddress: WALLET_H, contract: '0xbbbb000000000000000000000000000000000b', symbol: 'BBB', amountRaw: '1000', tokenDecimals: 18 }, // missing_tx_hash
    { provider: 'goldrush', chain: 'base', txHash: '0xmissingtimestamp', timestamp: null, fromAddress: '0xrouter00000000000000000000000000000000', toAddress: WALLET_H, contract: '0xbbbb000000000000000000000000000000000b', symbol: 'BBB', amountRaw: '1000', tokenDecimals: 18 }, // missing_timestamp
    { provider: 'goldrush', chain: 'base', txHash: '0xbadcontract', timestamp: isoMinusDays(4), fromAddress: '0xrouter00000000000000000000000000000000', toAddress: WALLET_H, contract: 'not-an-address', symbol: 'BBB', amountRaw: '1000', tokenDecimals: 18 }, // invalid_contract
    { provider: 'goldrush', chain: 'base', txHash: '0xzeroamount', timestamp: isoMinusDays(4), fromAddress: '0xrouter00000000000000000000000000000000', toAddress: WALLET_H, contract: '0xbbbb000000000000000000000000000000000b', symbol: 'BBB', amountRaw: '0', tokenDecimals: 18 }, // zero_amount
  ],
}

// ── 9. extremeActivityWallet — synthetic, high event volume, for O(n) performance testing ──
function buildExtremeActivityEvents(): RawProviderEvent[] {
  const events: RawProviderEvent[] = []
  for (let i = 0; i < 5000; i++) {
    const isBuy = i % 2 === 0
    const contract = `0x${(i % 50).toString(16).padStart(4, '0')}${'0'.repeat(36)}`
    events.push(
      isBuy
        ? buyEvent({ chain: 'base', wallet: WALLET_I, contract, symbol: `T${i % 50}`, timestamp: isoMinusDays(30 - (i % 30)) })
        : sellEvent({ chain: 'base', wallet: WALLET_I, contract, symbol: `T${i % 50}`, timestamp: isoMinusDays(29 - (i % 29)) }),
    )
  }
  return events
}

const extremeActivityWallet: WalletTestConfig = {
  name: 'extremeActivityWallet',
  walletAddress: WALLET_I,
  chains: ['base'],
  scanMode: 'normal',
  syntheticRawEvents: buildExtremeActivityEvents(),
}

// ── 10. hyperEvmBridgeWallet — synthetic, exercises HyperEVM end-to-end: a chainsScanned entry,
// a same-tx-shaped buy on HyperEVM itself, and a cross-chain bridge candidate
// (Arbitrum -> HyperEVM) for bridgeDetection to pick up. Demonstrates the full HyperEVM wiring
// (chain selection, timelines, FIFO, bridgeTimeline, windowCoverage) via the synthetic path, since
// no verified GoldRush/Alchemy provider integration exists yet to fetch a real HyperEVM wallet's
// data (see providerFetchWindow's HyperEVM TODO) — this is the honest way to prove the mechanism
// works without claiming a live-network result this environment cannot actually produce.
const hyperEvmBridgeWallet: WalletTestConfig = {
  name: 'hyperEvmBridgeWallet',
  walletAddress: WALLET_J,
  chains: ['base', 'arbitrum', 'hyperevm'],
  scanMode: 'deep',
  syntheticRawEvents: [
    // Bridge leg 1: wallet sends BRT out on Arbitrum...
    sellEvent({
      chain: 'arbitrum',
      wallet: WALLET_J,
      contract: '0xb61d9e0000000000000000000000000000000a12',
      symbol: 'BRT',
      amountRaw: '1000000000000000000',
      timestamp: isoMinutesAgo(30),
    }),
    // ...and receives it on HyperEVM ~6 minutes later (same symbol, near-identical amount, well
    // inside the 60-minute match window) -> a high-confidence bridge candidate.
    buyEvent({
      chain: 'hyperevm',
      wallet: WALLET_J,
      contract: '0xb61d9e0000000000000000000000000000000e99',
      symbol: 'BRT',
      amountRaw: '1000000000000000000',
      timestamp: isoMinutesAgo(24),
    }),
    // A second, unrelated buy on HyperEVM itself, so buyTimeline/fifoEngine have real HyperEVM
    // activity to work with beyond just the bridge leg.
    buyEvent({
      chain: 'hyperevm',
      wallet: WALLET_J,
      contract: '0x4a91d9e000000000000000000000000000000091',
      symbol: 'HYPT',
      amountRaw: '5000000000000000000',
      timestamp: isoMinusDays(4),
    }),
  ],
}

export const WALLET_TEST_CONFIGS: WalletTestConfig[] = [
  simpleWallet,
  multiChainWallet,
  highValueWallet,
  dustOnlyWallet,
  providerUnavailableWallet,
  recoveryTriggeredWallet,
  noRecoveryWallet,
  malformedEventsWallet,
  extremeActivityWallet,
  hyperEvmBridgeWallet,
]
