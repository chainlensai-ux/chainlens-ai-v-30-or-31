'use client'
// Thin client boundary so ssr:false works — server layout imports this wrapper
import dynamic from 'next/dynamic'

const MobileClarkDrawer = dynamic(() => import('@/components/MobileClarkDrawer'), { ssr: false })

export default function MobileClarkDrawerLazy() {
  return <MobileClarkDrawer />
}
