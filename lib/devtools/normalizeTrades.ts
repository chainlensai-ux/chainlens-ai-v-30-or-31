// lib/devtools/normalizeTrades.ts — dev-only browser console exposure for the Swap Normalization
// Engine (src/modules/swapNormalizer). Imported once from app/providers.tsx (a real 'use client'
// component that loads on every page), so this module is guaranteed to execute in the browser.
// SSR-safe: guarded on `typeof window !== 'undefined'`.
//
// GATING NOTE: Vercel sets NODE_ENV=production for every deployment, preview included — a strict
// `NODE_ENV !== 'production'` guard would make this unreachable on any Vercel URL, only on
// localhost via `next dev`. Gated instead on an explicit opt-in public env var
// (NEXT_PUBLIC_ENABLE_DEV_TOOLS), OFF by default (so it never appears in a real production
// deploy unless someone deliberately sets that var for that deployment), but settable per-preview
// when you actually want to use this console harness there.
import { normalizeTrades } from '@/src/modules/swapNormalizer'

declare global {
  interface Window {
    normalizeTrades?: typeof normalizeTrades
  }
}

const devToolsEnabled =
  process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === '1'

if (typeof window !== 'undefined' && devToolsEnabled) {
  window.normalizeTrades = normalizeTrades
}

export {}
