'use client'

import type { RadarPrediction, RadarPredictionCategory } from '@/lib/baseRadarSignals'

const CATEGORY_COLORS: Record<RadarPredictionCategory, string> = {
  'Momentum likely to continue': '#34d399',
  'Momentum slowing': '#fbbf24',
  'Momentum reversing': '#f87171',
  'No clear short-term signal': '#9ea1a4',
}

export default function NextFiveMinuteCard({ prediction }: { prediction: RadarPrediction }) {
  const color = CATEGORY_COLORS[prediction.category]
  return (
    <section style={{ border: `1px solid ${color}33`, background: `${color}0d`, borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
      <h3 style={{ margin: '0 0 8px', color: '#f8fafc', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Next 5-Minute Read</h3>
      <p style={{ margin: '0 0 6px', color, fontSize: '13px', fontWeight: 800 }}>{prediction.category}</p>
      <p style={{ margin: 0, color: '#d1d4d7', fontSize: '12px', lineHeight: 1.55 }}>{prediction.explanation}</p>
    </section>
  )
}
