import Navbar from '@/components/Navbar'
import Link from 'next/link'

export default function HomePage() {
  return (
    <main style={{ minHeight: '100vh', background: '#06060a' }}>
      <Navbar />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '120px 24px', textAlign: 'center' }}>
        <h1 style={{ fontSize: '48px', fontWeight: 700, background: 'linear-gradient(135deg, #8b5cf6, #ec4899, #2DD4BF)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', marginBottom: '16px' }}>
          ChainLens AI
        </h1>
        <p style={{ fontSize: '18px', color: 'rgba(255,255,255,0.5)', marginBottom: '32px' }}>
          Your crypto cockpit powered by Clark AI.
        </p>
        <Link href="/app" style={{ padding: '12px 28px', borderRadius: '10px', background: '#8b5cf6', color: '#fff', fontSize: '14px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.06em', textTransform: 'uppercase', boxShadow: '0 0 24px rgba(139,92,246,0.4)' }}>
          Enter Terminal
        </Link>
      </div>
    </main>
  )
}
