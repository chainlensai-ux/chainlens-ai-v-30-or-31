'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'

type PumpCategory = 'HIGH_MOMENTUM' | 'VOLUME_EXPANSION' | 'THIN_MOONSHOT' | 'WATCH'
type PumpRisk = 'HIGH' | 'MEDIUM' | 'LOW'

interface PumpAlert {
  symbol: string
  name: string
  contract: string
  chain: 'base' | 'eth' | 'robinhood'
  chainId: number
  pairAddress: string | null
  priceUsd: number | null
  change24h: number | null
  change6h: number | null
  change1h: number | null
  change14d: number | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  tokenAgeDays: number | null
  evidenceSource?: 'exact' | 'live_momentum'
  evidenceGrade?: 'exact' | 'live_momentum'
  category: PumpCategory
  reason: string
  qualifyingReason: string
  riskLevel: PumpRisk
  tags: string[]
  priceChange24hPct?: number | null
  priceChange6hPct?: number | null
  priceChange1hPct?: number | null
}
