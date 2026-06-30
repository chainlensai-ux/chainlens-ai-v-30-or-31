// SMART-RECOVERY-ENGINE: isolated, additive module, admin-only. Does NOT reimplement swap
// detection, FIFO matching, or price evidence — it delegates entirely to the existing
// fetchWalletSnapshot pipeline (lib/server/walletSnapshot.ts), only adding a cheap window-detection
// pre-pass and admin-tunable page/price caps on top. Never invented trades or synthetic cost basis:
// whatever fetchWalletSnapshot's own integrity gates allow is all that comes back here.
import { fetchWalletSnapshot, WALLET_SCAN_MODE_CONFIG, type WalletSnapshot } from './walletSnapshot'
import { detectTradingWindow, type SmartRecoveryWindow } from './smartRecoveryWindow'

export type SmartRecoveryAdminControls = {
  adminForceWindowDetection?: boolean
  adminTargetedRecoveryOnly?: boolean
  adminDisableFullHistoryScan?: boolean
  adminMaxPages?: number
  adminMaxPriceAttempts?: number
}

export type SmartRecoveryResult = {
  smartRecoveryWindow: SmartRecoveryWindow
  smartRecoveryStatus: 'ok' | 'no_window_found' | 'window_detection_skipped'
  smartRecoveryPagesUsed: number
  smartRecoveryMaxPagesAllowed: number
  smartRecoveryMaxPriceAttemptsAllowed: number
  snapshot: WalletSnapshot
}

export async function runSmartRecovery(
  address: string,
  chain: 'eth' | 'base',
  controls: SmartRecoveryAdminControls,
): Promise<SmartRecoveryResult> {
  const baseConfig = WALLET_SCAN_MODE_CONFIG.full_recovery
  const maxPages = Math.max(1, Math.min(controls.adminMaxPages ?? baseConfig.targetedRecoveryPages, baseConfig.targetedRecoveryPages))
  const maxPriceAttempts = Math.max(1, Math.min(controls.adminMaxPriceAttempts ?? baseConfig.priceAttempts, baseConfig.priceAttempts))

  let window: SmartRecoveryWindow = {
    startTimestamp: null, endTimestamp: null, confidence: 'none', pagesUsed: 0, transfersSeen: 0, reason: 'window_detection_skipped',
  }
  let smartRecoveryStatus: SmartRecoveryResult['smartRecoveryStatus'] = 'window_detection_skipped'

  if (controls.adminForceWindowDetection !== false) {
    window = await detectTradingWindow(address, chain, 2)
    smartRecoveryStatus = window.startTimestamp ? 'ok' : 'no_window_found'
  }

  // adminDisableFullHistoryScan caps the targeted recovery to whatever window detection found —
  // never falls back to a full-history page sweep when the admin has explicitly disabled it.
  const targetedOnly = Boolean(controls.adminTargetedRecoveryOnly) || Boolean(controls.adminDisableFullHistoryScan)
  const effectivePages = targetedOnly && !window.startTimestamp ? 0 : maxPages

  const snapshot = await fetchWalletSnapshot(address, {
    chain,
    deepActivity: true,
    historicalCoverage: effectivePages > 0,
    maxHistoricalPages: effectivePages,
    maxFallbackPages: maxPriceAttempts,
    walletScanBudget: {
      scanMode: 'full_recovery',
      requestedHistoricalScan: effectivePages > 0,
      totalCreditTarget: baseConfig.targetCredits,
      totalCreditHardCap: baseConfig.hardCapCredits,
      adminOverrideUsed: true,
      scanModeConfig: baseConfig,
    },
  })

  return {
    smartRecoveryWindow: window,
    smartRecoveryStatus,
    smartRecoveryPagesUsed: effectivePages,
    smartRecoveryMaxPagesAllowed: maxPages,
    smartRecoveryMaxPriceAttemptsAllowed: maxPriceAttempts,
    snapshot,
  }
}
