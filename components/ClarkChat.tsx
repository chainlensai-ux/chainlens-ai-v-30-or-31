'use client'

import HeroSection from '@/components/HeroSection'
import HomeTokenScreener from '@/components/HomeTokenScreener'

export default function ClarkChat({ active }: { active: string | null }) {
  return (
    <div className="flex-1 overflow-y-auto" style={{ background: '#06060a' }}>
      <HeroSection />
      <HomeTokenScreener />
    </div>
  )
}
