// src/modules/lotCloser/closeLots.devtools.ts — dev-tools browser-console exposure for closeLots().
// Side-effect only: imported once from app/providers.tsx (a real 'use client' component loaded on
// every page), so this module is guaranteed to execute in the browser and never during
// SSR/hydration. Colocated with the module it exposes, same convention as
// src/modules/lotOpener/openLots.devtools.ts and src/modules/swapNormalizer/normalizeTrades.ts.
//
// GATING: opt-in only via NEXT_PUBLIC_ENABLE_DEV_TOOLS=1, identical pattern to the other three
// dev-console exposures. This is a NEXT_PUBLIC_ var, so it is resolved at BUILD time, not read live
// in the browser afterward — set it in your Vercel project's environment variables (non-Sensitive,
// correct environment scope) and trigger a new deployment for it to take effect.
import { closeLots } from './index'

declare global {
  interface Window {
    closeLots?: typeof closeLots
  }
}

if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === '1') {
  window.closeLots = closeLots
}

export {}
