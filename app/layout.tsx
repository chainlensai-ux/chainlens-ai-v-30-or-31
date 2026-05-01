import type { Metadata } from 'next'
import './globals.css'
import { SupabaseProvider } from '@/app/providers/SupabaseProvider'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: 'ChainLens AI — Crypto Intelligence Platform',
  description:
    'AI-powered crypto intelligence — wallet scanner, bear market scoring, paper trading and more.',
  themeColor: '#06060a',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="w-full min-h-dvh overflow-x-hidden">
        <Providers>
          <SupabaseProvider>
            {children}
          </SupabaseProvider>
        </Providers>
      </body>
    </html>
  )
}
