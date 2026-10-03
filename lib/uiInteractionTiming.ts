// lib/uiInteractionTiming.ts — debug-only interaction timing for the terminal (click → acknowledgement,
// click → route start, click → destination shell, mutation/refresh duration, duplicate-prevented).
//
// OFF by default and invisible in the product. Enable in a browser with
//   localStorage.setItem('chainlens:ui-timing', '1')   (or add ?uiTiming=1 to the URL once)
// Entries go to console.debug('[ui-timing]', …) and window.__chainlensUiTiming (last 100).
// Never makes a network request and never changes behaviour; every call is a cheap no-op when off.

type TimingEntry = { name: string; phase: string; ms: number; at: number; detail?: Record<string, unknown> }
const STORAGE_KEY = 'chainlens:ui-timing'
const NAV_KEY = 'chainlens:ui-timing:nav'
const MAX_ENTRIES = 100

let cachedEnabled: boolean | null = null
export function uiTimingEnabled(): boolean {
  if (cachedEnabled != null) return cachedEnabled
  if (typeof window === 'undefined') return false
  try {
    if (new URLSearchParams(window.location.search).get('uiTiming') === '1') window.localStorage.setItem(STORAGE_KEY, '1')
    cachedEnabled = window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    cachedEnabled = false
  }
  return cachedEnabled
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function record(entry: TimingEntry) {
  const w = window as unknown as { __chainlensUiTiming?: TimingEntry[] }
  const list = (w.__chainlensUiTiming ??= [])
  list.push(entry)
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
  console.debug('[ui-timing]', entry.name, entry.phase, `${entry.ms.toFixed(1)}ms`, entry.detail ?? '')
}

export type InteractionTimer = {
  /** First visual acknowledgement (optimistic state painted). Measured at the next frame. */
  ack: () => void
  /** Navigation is about to start; the destination reports its shell via reportDestinationShell(). */
  routeStart: (destination: string) => void
  /** A mutation/refresh finished. */
  done: (detail?: Record<string, unknown>) => void
  /** A repeated click was ignored because the same work was already in flight. */
  duplicatePrevented: () => void
}

const NOOP: InteractionTimer = { ack() {}, routeStart() {}, done() {}, duplicatePrevented() {} }

export function startInteraction(name: string): InteractionTimer {
  if (!uiTimingEnabled()) return NOOP
  const t0 = now()
  const wallStart = Date.now()
  return {
    ack() {
      requestAnimationFrame(() => record({ name, phase: 'click→ack', ms: now() - t0, at: Date.now() }))
    },
    routeStart(destination) {
      record({ name, phase: 'click→route-start', ms: now() - t0, at: Date.now(), detail: { destination } })
      try { window.sessionStorage.setItem(NAV_KEY, JSON.stringify({ name, destination, wallStart })) } catch { /* debug only */ }
    },
    done(detail) {
      record({ name, phase: 'duration', ms: now() - t0, at: Date.now(), detail })
    },
    duplicatePrevented() {
      record({ name, phase: 'duplicate-prevented', ms: now() - t0, at: Date.now() })
    },
  }
}

/** Call once from a destination page's mount effect: logs click → destination shell for the last tracked navigation. */
export function reportDestinationShell(page: string) {
  if (!uiTimingEnabled()) return
  try {
    const raw = window.sessionStorage.getItem(NAV_KEY)
    if (!raw) return
    window.sessionStorage.removeItem(NAV_KEY)
    const mark = JSON.parse(raw) as { name: string; destination: string; wallStart: number }
    requestAnimationFrame(() => record({ name: mark.name, phase: 'click→destination-shell', ms: Date.now() - mark.wallStart, at: Date.now(), detail: { page, destination: mark.destination } }))
  } catch { /* debug only */ }
}
