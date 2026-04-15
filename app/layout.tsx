import type { Metadata } from 'next'
import { Inter, IBM_Plex_Mono } from 'next/font/google'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'ChainLens AI — Crypto Intelligence Platform',
  description: 'AI-powered crypto intelligence — wallet scanner, bear market scoring, paper trading and more.',
  themeColor: '#06060a',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${ibmPlexMono.variable}`}>
      <body style={{ background: '#06060a', color: '#fff', fontFamily: 'var(--font-inter), Inter, sans-serif', overflowX: 'hidden' }}>
        {children}
      </body>
    </html>
  )
}
