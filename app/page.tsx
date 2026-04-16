import type { Metadata, Viewport } from 'next'
import Navbar from '@/components/Navbar'
import HeroSection from '@/components/HeroSection'
import HomeTokenScreener from '@/components/HomeTokenScreener'

export const metadata: Metadata = {
  title: 'ChainLens AI — See The Market Before It Moves',
  description:
    'Track smart money, scan wallets, detect pumps, and discover Base opportunities in real time.',
}

export const viewport: Viewport = {
  themeColor: '#06060a',
}

export default function HomePage() {
  return (
    <div style={{ background: '#06060a', minHeight: '100vh' }}>
      <Navbar />
      <HeroSection />
      <HomeTokenScreener />
    </div>
  )
}
