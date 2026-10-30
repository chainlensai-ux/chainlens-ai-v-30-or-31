// Process-wide gates for provider calls that are issued from many concurrent pricing paths at once.
// A per-call-site concurrency limit cannot see the other call sites, so the provider's own limit is
// enforced here, once, for every caller.
//
// - createPacingGate: starts at most `perSecond` requests per second (even spacing, no burst). Used for
//   GoldRush pricing: a live Base scan sent ~16/s against a key that sustains ~4/s and got 72-83% 429s.
// - createConcurrencyGate: at most `max` requests in flight. Used for CoinGecko contract pricing: a live
//   scan had up to 369 requests in flight at once, so its first-429 breaker tripped only after hundreds
//   of requests were already sent.

export type PacingGate = { wait(): Promise<void>; reset(): void }

export function createPacingGate(perSecond: number, now: () => number = Date.now): PacingGate {
  const spacingMs = 1000 / Math.max(0.1, perSecond)
  let nextSlotAt = 0
  return {
    async wait() {
      const t = now()
      const slot = Math.max(t, nextSlotAt)
      nextSlotAt = slot + spacingMs
      if (slot > t) await new Promise((resolve) => setTimeout(resolve, slot - t))
    },
    reset() { nextSlotAt = 0 },
  }
}

export type ConcurrencyGate = { run<T>(task: () => Promise<T>): Promise<T>; inFlight(): number; reset(): void }

export function createConcurrencyGate(max: number): ConcurrencyGate {
  const limit = Math.max(1, Math.floor(max))
  let active = 0
  let queue: Array<() => void> = []
  const release = () => {
    active -= 1
    const next = queue.shift()
    if (next) { active += 1; next() }
  }
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve))
      else active += 1
      try { return await task() } finally { release() }
    },
    inFlight: () => active,
    // Queued waiters are released so nothing hangs; they then run normally.
    reset() { const waiting = queue; queue = []; active = 0; for (const resolve of waiting) { active += 1; resolve() } },
  }
}

// Positive finite number from an environment value, or the fallback.
export function envRate(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Shared by every GoldRush historical-pricing call site (the SDK price source and walletSnapshot's
// REST lookup). Default 4/s, the sustained rate measured on the configured key; a plan with a higher
// limit sets GOLDRUSH_PRICING_MAX_RPS.
export const goldrushPricingGate = createPacingGate(envRate(process.env.GOLDRUSH_PRICING_MAX_RPS, 4))
