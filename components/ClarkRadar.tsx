'use client'

import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

// ─── Mock data ────────────────────────────────────────────────────────────

const WHALE_ALERTS = [
  { token: 'ETH', amount: '$2.4M',  action: 'Large transfer detected',  severity: 'HIGH',   up: true  },
  { token: 'SOL', amount: '$890K',  action: 'Whale accumulation signal', severity: 'MEDIUM', up: true  },
  { token: 'UNI', amount: '$1.8M',  action: 'Large sell pressure',       severity: 'HIGH',   up: false },
]

const AI_SIGNALS = [
  { name: 'Bitcoin',  sym: 'BTC',  bar: 78, label: 'BULLISH', color: '#f59e0b' },
  { name: 'Ethereum', sym: 'ETH',  bar: 62, label: 'BULLISH', color: '#627EEA' },
  { name: 'Base Eco', sym: 'BASE', bar: 44, label: 'NEUTRAL', color: '#2DD4BF' },
]

const LIVE_ACTIVITY = [
  { text: '0x7a25…88D bought $12K BRETT on Base',  time: '30s' },
  { text: 'New pair BONK/WETH deployed on Base',    time: '1m'  },
  { text: '0xd8dA…6045 sold 50K TOSHI',             time: '4m'  },
  { text: 'Whale bridged 18 ETH → Base chain',      time: '9m'  },
  { text: 'Smart wallet added $80K LP on AERO',     time: '14m' },
]

// ─── Section card ─────────────────────────────────────────────────────────

function Section({
  title,
  accent,
  delay = 0,
  children,
}: {
  title:     string
  accent?:   string
  delay?:    number
  children:  ReactNode
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: 'easeOut' }}
      className="rounded-2xl overflow-hidden"
      style={{ background: '#070d1a', border: '1px solid rgba(255,255,255,0.10)', boxShadow: '0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)' }}
    >
      {/* Section header row */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.035)' }}
      >
        <span
          className="uppercase"
          style={{
            fontSize: '10px',
            fontWeight: 800,
            letterSpacing: '0.15em',
            color: '#4a7494',
            fontFamily: 'var(--font-plex-mono)',
          }}
        >
          {title}
        </span>
        {accent && (
          <span
            className="font-bold tracking-wider"
            style={{
              fontSize: '9px',
              fontFamily: 'var(--font-plex-mono)',
              color: '#2DD4BF',
            }}
          >
            {accent}
          </span>
        )}
      </div>
      <div className="p-4">{children}</div>
    </motion.div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────

export default function ClarkRadar({ onSelectRadar }: { onSelectRadar: (val: string) => void }) {
  return (
    <div>

      {/* Panel header — sticky */}
      <div
        className="flex items-center justify-between px-5 h-14"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: '#0a0d16',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <span
          className="tracking-tight"
          style={{
            fontSize: '14px',
            fontWeight: 700,
            color: '#f1f5f9',
            fontFamily: 'var(--font-inter)',
          }}
        >
          Market Intelligence
        </span>
        {/* LIVE indicator */}
        <div className="flex items-center gap-2">
          <div
            className="rounded-full bg-[#2DD4BF]"
            style={{ width: '7px', height: '7px', boxShadow: '0 0 8px rgba(45,212,191,0.9)' }}
          />
          <span
            className="font-bold tracking-widest text-[#2DD4BF]"
            style={{ fontSize: '10px', fontFamily: 'var(--font-plex-mono)' }}
          >
            LIVE
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-4 space-y-4">

        {/* ── Whale Alerts ─────────────────────────── */}
        <Section title="Whale Alerts" delay={0}>
          <div className="space-y-2.5">
            {WHALE_ALERTS.map((w, i) => (
              <div
                key={i}
                className="flex items-center gap-3 p-3 rounded-xl"
                style={{
                  background: 'rgba(255,255,255,0.025)',
                  border: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                {/* Token icon — 38px, teal or rose tint */}
                <div
                  className="flex items-center justify-center shrink-0 font-bold"
                  style={{
                    width: '38px',
                    height: '38px',
                    borderRadius: '12px',
                    fontSize: '10px',
                    background: w.up ? 'rgba(45,212,191,0.1)'  : 'rgba(251,113,133,0.1)',
                    color:      w.up ? '#2DD4BF'                : '#fb7185',
                    border:     `1px solid ${w.up ? 'rgba(45,212,191,0.2)' : 'rgba(251,113,133,0.2)'}`,
                    fontFamily: 'var(--font-plex-mono)',
                  }}
                >
                  {w.token}
                </div>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  <p
                    className="font-bold leading-tight"
                    style={{ fontSize: '12px', fontFamily: 'var(--font-plex-mono)', color: '#e2e8f0' }}
                  >
                    {w.amount}
                  </p>
                  <p
                    className="mt-0.5 truncate"
                    style={{ fontSize: '10px', color: '#4e6e88', fontFamily: 'var(--font-inter)' }}
                  >
                    {w.action}
                  </p>
                </div>

                {/* Severity badge */}
                <span
                  className="shrink-0 font-bold px-1.5 py-0.5 rounded border uppercase"
                  style={{
                    fontSize: '8px',
                    fontFamily: 'var(--font-plex-mono)',
                    ...(w.severity === 'HIGH'
                      ? { color: '#fb7185', background: 'rgba(251,113,133,0.08)', border: '1px solid rgba(251,113,133,0.2)' }
                      : w.severity === 'MEDIUM'
                      ? { color: '#fbbf24', background: 'rgba(251,191,36,0.08)',  border: '1px solid rgba(251,191,36,0.2)'  }
                      : { color: '#2DD4BF', background: 'rgba(45,212,191,0.08)',  border: '1px solid rgba(45,212,191,0.2)'  }),
                  }}
                >
                  {w.severity}
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* ── AI Signals ───────────────────────────── */}
        <Section title="AI Signals" accent="CORTEX" delay={0.07}>
          <div className="space-y-4">
            {AI_SIGNALS.map((s, i) => (
              <div key={i}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {/* Token icon */}
                    <div
                      className="flex items-center justify-center shrink-0 font-bold"
                      style={{
                        width: '24px',
                        height: '24px',
                        borderRadius: '8px',
                        fontSize: '8px',
                        background: `${s.color}15`,
                        color: s.color,
                        border: `1px solid ${s.color}28`,
                        fontFamily: 'var(--font-plex-mono)',
                      }}
                    >
                      {s.sym.slice(0, 2)}
                    </div>
                    <span
                      className="font-semibold"
                      style={{ fontSize: '12px', color: '#cbd5e1', fontFamily: 'var(--font-inter)' }}
                    >
                      {s.name}
                    </span>
                  </div>
                  {/* Bullish/Neutral badge */}
                  <span
                    className="font-bold px-1.5 py-0.5 rounded border"
                    style={{
                      fontSize: '8px',
                      fontFamily: 'var(--font-plex-mono)',
                      ...(s.label === 'BULLISH'
                        ? { color: '#2DD4BF', background: 'rgba(45,212,191,0.08)',  border: '1px solid rgba(45,212,191,0.2)'  }
                        : s.label === 'BEARISH'
                        ? { color: '#fb7185', background: 'rgba(251,113,133,0.08)', border: '1px solid rgba(251,113,133,0.2)' }
                        : { color: '#fbbf24', background: 'rgba(251,191,36,0.08)',  border: '1px solid rgba(251,191,36,0.2)'  }),
                    }}
                  >
                    {s.label}
                  </span>
                </div>

                {/* Progress bar */}
                <div
                  className="h-1.5 rounded-full overflow-hidden"
                  style={{ background: 'rgba(255,255,255,0.06)' }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${s.bar}%`,
                      background:
                        s.label === 'BULLISH'
                          ? 'linear-gradient(90deg, rgba(45,212,191,0.55), #2DD4BF)'
                          : s.label === 'BEARISH'
                          ? 'linear-gradient(90deg, rgba(251,113,133,0.55), #fb7185)'
                          : 'linear-gradient(90deg, rgba(251,191,36,0.55), #fbbf24)',
                    }}
                  />
                </div>
                <p
                  className="text-right mt-1"
                  style={{ fontSize: '10px', fontFamily: 'var(--font-plex-mono)', color: '#3e5c78' }}
                >
                  {s.bar}%
                </p>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Live Activity ────────────────────────── */}
        <Section title="Live Activity" accent="LIVE" delay={0.14}>
          <div className="space-y-2.5">
            {LIVE_ACTIVITY.map((a, i) => (
              <div key={i} className="flex items-start gap-2.5">
                {/* Teal dot with glow */}
                <div
                  className="shrink-0 rounded-full bg-[#2DD4BF] mt-[5px]"
                  style={{
                    width: '6px',
                    height: '6px',
                    boxShadow: '0 0 5px rgba(45,212,191,0.75)',
                  }}
                />
                <p
                  className="flex-1 leading-relaxed"
                  style={{ fontSize: '11px', color: '#7a90a8', fontFamily: 'var(--font-inter)' }}
                >
                  {a.text}
                </p>
                <span
                  className="shrink-0 mt-0.5"
                  style={{ fontSize: '9px', fontFamily: 'var(--font-plex-mono)', color: '#3e5c78' }}
                >
                  {a.time}
                </span>
              </div>
            ))}
          </div>

          {/* Footer — pulsing CORTEX monitoring label */}
          <div
            className="mt-4 flex items-center gap-2 pt-3"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div
              className="rounded-full bg-[#2DD4BF] animate-pulse"
              style={{ width: '6px', height: '6px', boxShadow: '0 0 5px rgba(45,212,191,0.8)' }}
            />
            <span
              style={{ fontSize: '11px', color: '#4e6e88', fontFamily: 'var(--font-inter)' }}
            >
              CORTEX monitoring live
            </span>
          </div>
        </Section>

      </div>
    </div>
  )
}
