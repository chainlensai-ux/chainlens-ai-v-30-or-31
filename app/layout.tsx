import type { Metadata } from 'next'
import { Inter, IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import { SupabaseProvider } from '@/app/providers/SupabaseProvider'
import { Providers } from './providers'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-mono',
  display: 'swap',
})

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
    <html lang="en" className={`${inter.variable} ${ibmPlexMono.variable}`}>
      <body className="w-full h-full">
        <Providers>
          <SupabaseProvider>
            {children}
          </SupabaseProvider>
        </Providers>
      </body>
    </html>
  )
}
