'use client'
import React, { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import type { AccountHistoryReceipt } from '@/lib/server/accountScanHistory'

export default function AccountHistorySaveNotice({ receipt, onSaved }: { receipt?: AccountHistoryReceipt | null; onSaved: (receipt: AccountHistoryReceipt) => void }) {
  const [busy, setBusy] = useState(false)
  if (!receipt || receipt.status === 'saved' || receipt.status === 'duplicate') return null
  async function retry() {
    if (busy || !receipt?.retryToken) return
    setBusy(true)
    try {
      const { data } = await supabase.auth.getSession()
      if (!data.session) return
      const response = await fetch('/api/cortex/history', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify({ retryToken: receipt.retryToken }) })
      const result = await response.json()
      if (response.ok && (result.accountHistory?.status === 'saved' || result.accountHistory?.status === 'duplicate')) onSaved(result.accountHistory)
    } catch { /* Keep the explicit unsaved state; retries are manual and bounded. */ }
    finally { setBusy(false) }
  }
  return <p role="status" style={{ color: '#fbbf24', fontSize: 12 }}>This scan has not been saved to your account. Existing history is unaffected.{' '}{receipt.retryToken && <button type="button" disabled={busy} onClick={retry}>{busy ? 'Saving…' : 'Retry saving'}</button>}</p>
}
