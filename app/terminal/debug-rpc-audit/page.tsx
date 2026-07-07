'use client'

// Debug-only page — NEW, isolated route, not linked from any nav menu, does not modify any existing
// page. Subscribes to app/api/debug/rpc-audit-stream's SSE feed and mirrors every event into the
// BROWSER's own console (requirement 4) — the whole reason this page exists, since
// lib/server/globalRpcAudit.ts's console.info/warn calls only ever reach the SERVER's log output,
// never the browser, no matter how long you watch the terminal.
//
// GATING, DISCLOSED: this page itself is not access-gated — the SSE route it calls already enforces
// the real gate (open on preview/dev, admin-secret-only on real production; see that route's own
// header). If the stream 404s (e.g. hitting this in real production without an admin token), that's
// surfaced on-page rather than left as a silent, confusing blank screen.

import { useEffect, useRef, useState } from 'react'

type RpcAuditEvent = {
  type: 'call' | 'burst' | 'poll'
  callerFile: string
  method: string
  timestamp: number
  count: number
}

export default function DebugRpcAuditPage() {
  const [events, setEvents] = useState<RpcAuditEvent[]>([])
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const source = new EventSource('/api/debug/rpc-audit-stream')
    sourceRef.current = source

    source.addEventListener('rpc', (raw: MessageEvent<string>) => {
      // Requirement 4's literal log line — every event lands in the browser's own DevTools console.
      // eslint-disable-next-line no-console
      console.warn('[RPC AUDIT STREAM]', raw.data)

      try {
        const parsed = JSON.parse(raw.data) as RpcAuditEvent
        setEvents((prev) => [parsed, ...prev].slice(0, 200))
        setConnectionError(null)
      } catch {
        // A malformed event is logged above already; nothing further to do for the on-page list.
      }
    })

    source.onerror = () => {
      setConnectionError('Stream disconnected or unavailable (404 in production without an admin token is expected).')
    }

    return () => {
      source.close()
      sourceRef.current = null
    }
  }, [])

  return (
    <div style={{ padding: 24, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: '#e2e8f0' }}>
      <h1 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>RPC Audit Stream (debug)</h1>
      <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
        Live feed of lib/server/globalRpcAudit.ts events. Also mirrored to this browser tab&apos;s
        DevTools console as <code>[RPC AUDIT STREAM]</code>.
      </p>
      {connectionError && (
        <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 16 }}>{connectionError}</div>
      )}
      <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {events.length === 0 && !connectionError && <div style={{ color: '#64748b' }}>Waiting for events…</div>}
        {events.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 12 }}>
            <span style={{ color: e.type === 'call' ? '#38bdf8' : e.type === 'burst' ? '#f87171' : '#facc15' }}>{e.type}</span>
            <span>{e.method}</span>
            <span style={{ color: '#64748b' }}>{e.callerFile}</span>
            <span style={{ color: '#64748b' }}>count={e.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
