'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabaseClient'

type ChainKey = 'base' | 'eth' | 'robinhood'

type DrawerPreloadOptions = {
  chain?: ChainKey
  liquidityUsd?: number | null
}

// INTENT-ONLY PRELOAD (P0 GeckoTerminal rate-limit incident): rows used to preload as soon as they came
// within 420px of the viewport. Each preload is a full /api/token scan (several GeckoTerminal requests),
// so simply opening or scrolling Base Radar / Watchlist spent the shared GeckoTerminal quota for every
// visible row, again after every 120s feed refresh. Preloading now needs a signal of intent: keyboard
// focus or a click (immediately), or the pointer resting on a row for HOVER_INTENT_MS (a sweep across
// rows starts nothing). The drawer's own query uses the same key, so a preload in flight is reused.
export const HOVER_INTENT_MS = 150

type DrawerPreloadState = 'idle' | 'warming' | 'cached'

const warmedTokens = new Map<string, number>()
const WARM_TTL_MS = 60_000

async function fetchJson<T>(url: string): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  const res = await fetch(url, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {} })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(typeof json?.error === 'string' ? json.error : `Request failed (${res.status})`)
  return json as T
}

function tokenKey(chain: ChainKey, tokenAddress: string) {
  return `${chain}:${tokenAddress.toLowerCase()}`
}

export function useDrawerPreload(tokenAddress: string | null | undefined, options: DrawerPreloadOptions = {}) {
  const chain = options.chain ?? 'base'
  const queryClient = useQueryClient()
  const [state, setState] = useState<DrawerPreloadState>('idle')
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const normalized = tokenAddress?.trim() ?? ''

  const preload = useCallback(() => {
    if (!normalized) return
    const key = tokenKey(chain, normalized)
    const warmedAt = warmedTokens.get(key)
    if (warmedAt && Date.now() - warmedAt < WARM_TTL_MS) {
      setState('cached')
      return
    }

    setState('warming')
    const query = `contract=${encodeURIComponent(normalized)}&chain=${chain}`
    const simulationQuery = `address=${encodeURIComponent(normalized)}&chain=${chain}&liquidityUsd=${encodeURIComponent(String(options.liquidityUsd ?? ''))}`

    void Promise.allSettled([
      queryClient.prefetchQuery({
        queryKey: ['base-radar-drawer-enrichment', chain, normalized],
        queryFn: () => fetchJson(`/api/base-radar/enrichment?${query}`),
        staleTime: WARM_TTL_MS,
      }),
      queryClient.prefetchQuery({
        queryKey: ['base-radar-drawer-simulation', chain, normalized, options.liquidityUsd ?? null],
        queryFn: () => fetchJson(`/api/radar/simulation?${simulationQuery}`),
        staleTime: WARM_TTL_MS,
      }),
    ]).then(() => {
      warmedTokens.set(key, Date.now())
      setState('cached')
    })
  }, [chain, normalized, options.liquidityUsd, queryClient])

  const cancelHoverPreload = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
  }, [])

  const preloadOnHover = useCallback(() => {
    cancelHoverPreload()
    hoverTimerRef.current = setTimeout(() => { hoverTimerRef.current = null; preload() }, HOVER_INTENT_MS)
  }, [cancelHoverPreload, preload])

  useEffect(() => () => cancelHoverPreload(), [cancelHoverPreload])

  const cached = useMemo(() => Boolean(normalized && warmedTokens.has(tokenKey(chain, normalized))), [chain, normalized])

  return { preload, preloadOnHover, cancelHoverPreload, state: cached ? 'cached' as const : state, cached }
}
