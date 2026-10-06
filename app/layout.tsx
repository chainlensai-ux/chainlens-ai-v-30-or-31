import type { Metadata, Viewport } from 'next'
import { Suspense } from 'react'
import Script from 'next/script'
import { headers } from 'next/headers'
import { cookieToInitialState } from 'wagmi'
import localFont from 'next/font/local'
import './globals.css'

// SORA/JAKARTA, DISCLOSED: the Aurora Terminal homepage redesign was designed against Sora
// (headings) and Plus Jakarta Sans (body) so it wouldn't fall back to a generic system sans —
// but nothing in the app ever loaded either family, so the real page silently fell back to
// system-ui and read visibly different from the approved mockup. Loaded here as CSS vars
// (additive, doesn't touch the existing --font-inter default) so ReferenceHero/Navbar can opt in.
// SELF-HOSTED: same families/weights/latin subset as the former next/font/google calls, served from
// app/fonts (OFL, from @fontsource) so a Google Fonts download hiccup can never fail the Vercel build.
const sora = localFont({
  src: [
    { path: './fonts/sora-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './fonts/sora-latin-700-normal.woff2', weight: '700', style: 'normal' },
    { path: './fonts/sora-latin-800-normal.woff2', weight: '800', style: 'normal' },
  ],
  variable: '--font-sora',
  display: 'swap',
})
const jakarta = localFont({
  src: [
    { path: './fonts/plus-jakarta-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/plus-jakarta-sans-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/plus-jakarta-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-jakarta',
  display: 'swap',
})
import { SupabaseProvider } from '@/app/providers/SupabaseProvider'
import { Providers } from './providers'
import AffiliateRefCapture from '@/components/AffiliateRefCapture'
// Lazy client wrapper — defers the full chat drawer bundle from the initial page load
import MobileClarkDrawerLazy from '@/components/MobileClarkDrawerLazy'
import { wagmiConfig, decodeWagmiCookieHeader } from '@/lib/wallet'

const SITE_URL = 'https://www.chainlensai.app'
const TITLE = 'ChainLens AI — Base Onchain Intelligence Terminal'
const DESCRIPTION =
  'Scan tokens, track whales, detect pumps, analyze wallets, and ask Clark AI what matters on Base.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  icons: {
    icon: [
      { url: '/favicon.ico',     sizes: 'any' },
      { url: '/favicon-32.png',  sizes: '32x32',   type: 'image/png' },
      { url: '/icon.png',        sizes: '512x512',  type: 'image/png' },
      { url: '/favicon.svg',     type: 'image/svg+xml' },
    ],
    apple: { url: '/apple-icon.png', sizes: '180x180', type: 'image/png' },
    shortcut: '/favicon.ico',
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'ChainLens AI',
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: '/icon.png', width: 512, height: 512, alt: 'ChainLens AI' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/icon.png'],
  },
  // BASE-APP-VERIFICATION, DISCLOSED (explicitly requested: Base dashboard domain verification).
  other: {
    'base:app_id': '6a7bfc563d490b7a57a0672c',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#050816',
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const headersList = await headers()
  const cookie = decodeWagmiCookieHeader(headersList.get('cookie'))
  const initialState = cookieToInitialState(wagmiConfig, cookie)

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`w-full min-h-dvh overflow-x-hidden ${sora.variable} ${jakarta.variable}`} suppressHydrationWarning>
        <Script id="android-safe-prehydrate" strategy="beforeInteractive">
          {`(function(){try{var ua=navigator.userAgent||'';var isAndroid=/Android/i.test(ua);var isMobile=(window.innerWidth||0)<768;var forced=(new URLSearchParams(window.location.search)).get('mobileSafe')==='android';if((isAndroid&&isMobile)||forced){document.documentElement.classList.add('android-safe-mode');document.body&&document.body.classList.add('android-safe-mode');}}catch(e){}})();`}
        </Script>
        <Providers initialState={initialState}>
          <SupabaseProvider>
            <Suspense fallback={null}><AffiliateRefCapture /></Suspense>
            {children}
          </SupabaseProvider>
        </Providers>
        <MobileClarkDrawerLazy />
      </body>
    </html>
  )
}
