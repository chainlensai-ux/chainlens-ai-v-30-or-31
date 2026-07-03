// src/modules/lotOpener/openLots.devtools.ts — dev-tools browser-console exposure for openLots().
// Side-effect only: imported once from app/providers.tsx (a real 'use client' component loaded on
// every page), so this module is guaranteed to execute in the browser and never during
// SSR/hydration. Colocated with the module it exposes, same convention as
// src/modules/swapNormalizer/normalizeTrades.ts (which exposes normalizeTrades/classifyTradeIntent).
//
// GATING: opt-in only via NEXT_PUBLIC_ENABLE_DEV_TOOLS=1, identical pattern to the other two
// dev-console exposures. This is a NEXT_PUBLIC_ var, so it is resolved at BUILD time, not read live
// in the browser afterward — set it in your Vercel project's environment variables and trigger a
// new deployment for it to take effect; toggling it after a build is already live will not
// retroactively enable this.
import { openLots } from './index'

declare global {
  interface Window {
    openLots?: typeof openLots
  }
}

if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === '1') {
  window.openLots = openLots
}

export {}
