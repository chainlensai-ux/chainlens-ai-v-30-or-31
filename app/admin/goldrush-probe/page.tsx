'use client'

// /admin/goldrush-probe — runs /api/debug/goldrush-history-probe with the signed-in admin's session (the
// admin layout already restricts this route to ADMIN_EMAILS) and shows the JSON with a copy button.

import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

const DEFAULT_WALLET = '0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811'

export default function GoldrushProbePage() {
  const [wallet, setWallet] = useState(DEFAULT_WALLET)
  const [output, setOutput] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)

  const run = async () => {
    setRunning(true)
    setCopied(false)
    setOutput('Running — this can take up to a minute…')
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) { setOutput('Not signed in.'); return }
      const qs = new URLSearchParams({ wallet: wallet.trim(), chain: 'base-mainnet', maxPages: '30' })
      const res = await fetch(`/api/debug/goldrush-history-probe?${qs}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      const text = await res.text()
      try { setOutput(JSON.stringify(JSON.parse(text), null, 2)) } catch { setOutput(`HTTP ${res.status}: ${text}`) }
    } catch (err) {
      setOutput(`Request failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
    }
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(output); setCopied(true) } catch { setCopied(false) }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#050607', color: '#e4e7ea', padding: '32px 16px', fontFamily: 'var(--font-plex-mono, monospace)' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <h1 style={{ fontSize: 20, margin: '0 0 6px' }}>GoldRush history probe</h1>
        <p style={{ fontSize: 12, color: '#9ea1a4', margin: '0 0 18px' }}>Measures how much wallet history GoldRush returns, how fast, and whether it includes USD prices and decoded swaps. Up to ~33 GoldRush calls per run.</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <input value={wallet} onChange={(e) => setWallet(e.target.value)} spellCheck={false}
            style={{ flex: '1 1 420px', minWidth: 0, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.14)', background: '#0b0d0f', color: '#e4e7ea', fontFamily: 'inherit', fontSize: 13 }} />
          <button onClick={run} disabled={running}
            style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #2ad8df', background: 'rgba(31,214,220,0.12)', color: '#fff', fontWeight: 700, cursor: running ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
            {running ? 'Running…' : 'Run probe'}
          </button>
          <button onClick={copy} disabled={!output || running}
            style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: '#e4e7ea', cursor: 'pointer', fontFamily: 'inherit' }}>
            {copied ? 'Copied' : 'Copy result'}
          </button>
        </div>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5, padding: 16, borderRadius: 12, background: '#0b0d0f', border: '1px solid rgba(255,255,255,0.08)', minHeight: 200 }}>{output || 'Press "Run probe".'}</pre>
      </div>
    </main>
  )
}
