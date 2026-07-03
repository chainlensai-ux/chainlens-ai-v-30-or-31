// src/modules/swapNormalizer/normalizeTrades.ts — dev-tools browser-console exposure for
// normalizeTrades() and classifyTradeIntent(). Side-effect only: imported once from
// app/providers.tsx (a real 'use client' component loaded on every page), so this module is
// guaranteed to execute in the browser and never during SSR/hydration.
//
// MOVED HERE FROM lib/devtools/normalizeTrades.ts (this session's prior location) per explicit
// request to keep the dev-console exposure file colocated with the module it exposes.
//
// classifyTradeIntent() ADDED HERE (was previously only exported from src/modules/tradeIntent, never
// exposed to window) — a prior request assumed it was already wired up; it wasn't, so this file
// still had a real gap between "should exist" and "actually deployed". Kept in this same file
// rather than a third exposure file, since both are dev-console tools with the identical gating
// requirement and the same single call site in providers.tsx.
//
// GATING: opt-in only via NEXT_PUBLIC_ENABLE_DEV_TOOLS=1. This is a NEXT_PUBLIC_ var, so it is
// resolved at BUILD time, not read live in the browser afterward — set it in your Vercel project's
// environment variables and trigger a new deployment for it to take effect; toggling it after a
// build is already live will not retroactively enable this.
import { normalizeTrades } from './index'
import { classifyTradeIntent } from '../tradeIntent/intentEngine'

declare global {
  interface Window {
    normalizeTrades?: typeof normalizeTrades
    classifyTradeIntent?: typeof classifyTradeIntent
  }
}

if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === '1') {
  window.normalizeTrades = normalizeTrades
  window.classifyTradeIntent = classifyTradeIntent
}

export {}
