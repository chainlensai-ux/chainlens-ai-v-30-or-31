// src/modules/realizedPnl/computeRealizedPnl.devtools.ts — dev-tools browser-console exposure for
// computeRealizedPnl(). Side-effect only: imported once from app/providers.tsx (a real 'use client'
// component loaded on every page), so this module is guaranteed to execute in the browser and
// never during SSR/hydration. Same colocated-exposure-file convention as normalizeTrades.ts,
// openLots.devtools.ts, and closeLots.devtools.ts.
//
// GATING: opt-in only via NEXT_PUBLIC_ENABLE_DEV_TOOLS=1, identical pattern to the other four
// dev-console exposures. This is a NEXT_PUBLIC_ var, so it is resolved at BUILD time, not read live
// in the browser afterward — set it in your Vercel project's environment variables (non-Sensitive,
// correct environment scope) and trigger a new deployment for it to take effect.
import { computeRealizedPnl } from './index'

declare global {
  interface Window {
    computeRealizedPnl?: typeof computeRealizedPnl
  }
}

if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === '1') {
  window.computeRealizedPnl = computeRealizedPnl
}

export {}
