import { Suspense } from 'react'
import TerminalPage from '../page'

export default function ClarkAiPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#94a3b8' }}>Loading Clark AI...</div>}>
      <TerminalPage />
    </Suspense>
  )
}
