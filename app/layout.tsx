import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { headers } from 'next/headers'
import { cookieToInitialState } from 'wagmi'
import './globals.css'
import { SupabaseProvider } from '@/app/providers/SupabaseProvider'
import { Providers } from './providers'
import MobileClarkDrawer from '@/components/MobileClarkDrawer'
import { wagmiConfig } from '@/lib/wallet'

export const metadata: Metadata = {
  title: 'ChainLens AI — Crypto Intelligence Platform',
  description:
    'AI-powered crypto intelligence — wallet scanner, bear market scoring, paper trading and more.',
  themeColor: '#06060a',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const headersList = await headers()
  const cookie = headersList.get('cookie')
  const initialState = cookieToInitialState(wagmiConfig, cookie)

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="w-full min-h-dvh overflow-x-hidden" suppressHydrationWarning>
        <Script id="android-safe-prehydrate" strategy="beforeInteractive">
          {`(function(){try{var ua=navigator.userAgent||'';var isAndroid=/Android/i.test(ua);var isMobile=(window.innerWidth||0)<768;var forced=(new URLSearchParams(window.location.search)).get('mobileSafe')==='android';if((isAndroid&&isMobile)||forced){document.documentElement.classList.add('android-safe-mode');document.body&&document.body.classList.add('android-safe-mode');}}catch(e){}})();`}
        </Script>
        <Providers initialState={initialState}>
          <SupabaseProvider>
            {children}
          </SupabaseProvider>
        </Providers>
        <MobileClarkDrawer />
      </body>
    </html>
  )
}
