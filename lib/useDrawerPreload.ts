'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

type ChainKey = 'base' | 'eth'

type DrawerPreloadOptions = {
  chain?: ChainKey
  liquidityUsd?: number | null
  rootMargin?: string
}

type DrawerPreloadState = 'idle' | 'warming' | 'cached'

const warmedTokens = new Map<string, number>()
const WARM_TTL_MS = 60_000

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
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
  const observerRef = useRef<IntersectionObserver | null>(null)
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

  const registerPreloadTarget = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect()
    if (!node || !normalized || typeof IntersectionObserver === 'undefined') return
    observerRef.current = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) preload()
    }, { rootMargin: options.rootMargin ?? '420px 0px' })
    observerRef.current.observe(node)
  }, [normalized, options.rootMargin, preload])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  const cached = useMemo(() => Boolean(normalized && warmedTokens.has(tokenKey(chain, normalized))), [chain, normalized])

  return { preload, registerPreloadTarget, state: cached ? 'cached' as const : state, cached }
}
