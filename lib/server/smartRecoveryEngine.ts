// SMART-RECOVERY-ENGINE: isolated, additive module, admin-only.
//
// V1 ENGINE DISABLED: this previously delegated entirely to fetchWalletSnapshot()
// (lib/server/walletSnapshot.ts). Per an explicit, confirmed request to cut V1 CU usage ahead of a
// V2 integration that hasn't landed yet, that call — and its value import, so no V1 code path can
// execute from this file — has been removed. (Verified before doing this: runSmartRecovery() has
// zero live callers anywhere in the current codebase — its only caller was app/api/wallet/route.ts,
// deleted earlier this session — so this change has zero user-facing blast radius.) The window
// pre-pass below (detectTradingWindow, lib/server/smartRecoveryWindow.ts) is untouched — it calls
// Moralis directly, not walletSnapshot.ts, so it isn't V1 and doesn't fire Alchemy RPC calls.
// WalletSnapshot stays as a type-only import (erased at compile time, never executes) since
// SmartRecoveryResult still needs to describe its real shape for the non-stub case.
import { WALLET_SCAN_MODE_CONFIG, type WalletSnapshot } from './walletSnapshot'
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
  snapshot: WalletSnapshot | { ok: false; error: 'V1 engine disabled' }
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

  const snapshot: SmartRecoveryResult['snapshot'] = { ok: false, error: 'V1 engine disabled' }

  return {
    smartRecoveryWindow: window,
    smartRecoveryStatus,
    smartRecoveryPagesUsed: effectivePages,
    smartRecoveryMaxPagesAllowed: maxPages,
    smartRecoveryMaxPriceAttemptsAllowed: maxPriceAttempts,
    snapshot,
  }
}
