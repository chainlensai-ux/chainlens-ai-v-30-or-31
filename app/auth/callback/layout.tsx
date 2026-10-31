import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
}

export default function AuthCallbackLayout({ children }: { children: ReactNode }) {
  return children
}
