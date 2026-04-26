'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

const BETA_PASSWORD = 'CHAINLENS2026'
const ACCESS_KEY = 'chainlens_beta_access'

export default function BetaPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const hasAccess = window.sessionStorage.getItem(ACCESS_KEY) === 'granted'

    if (hasAccess) {
      router.replace('/')
      return
    }

    setChecking(false)
  }, [router])

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (password.trim() === BETA_PASSWORD) {
      window.sessionStorage.setItem(ACCESS_KEY, 'granted')
      router.replace('/')
      return
    }

    setError('Incorrect beta password.')
  }

  const pageStyle: React.CSSProperties = {
    minHeight: '100vh',
    width: '100%',
    background: 'radial-gradient(circle at 20% 20%, rgba(45,212,191,0.10), transparent 30%), radial-gradient(circle at 80% 75%, rgba(139,92,246,0.10), transparent 35%), #06060a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 16px',
    overflowX: 'hidden',
    fontFamily: 'var(--font-inter), Inter, sans-serif',
  }

  const cardStyle: React.CSSProperties = {
    width: '100%',
    maxWidth: '400px',
    background: 'rgba(8,12,20,0.92)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '20px',
    padding: '32px 24px',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    boxShadow: '0 20px 70px rgba(0,0,0,0.55)',
    boxSizing: 'border-box',
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '12px 14px',
    borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(255,255,255,0.04)',
    color: '#e2e8f0',
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box',
    marginBottom: '10px',
  }

  const buttonStyle: React.CSSProperties = {
    width: '100%',
    padding: '12px 14px',
    borderRadius: '10px',
    border: 'none',
    background: '#2DD4BF',
    color: '#04101a',
    fontSize: '12px',
    fontWeight: 800,
    letterSpacing: '0.10em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    marginTop: '2px',
  }

  if (checking) {
    return (
      <main style={pageStyle}>
        <div style={cardStyle}>
          <div style={{ color: '#94a3b8', fontSize: '14px', textAlign: 'center' }}>Checking beta access...</div>
        </div>
      </main>
    )
  }

  return (
    <main style={pageStyle}>
      <form onSubmit={handleSubmit} style={cardStyle}>
        <div style={{
          width: '100%',
          textAlign: 'center',
          marginBottom: '10px',
          color: '#2DD4BF',
          fontWeight: 700,
          letterSpacing: '0.08em',
          fontSize: '12px',
          textTransform: 'uppercase',
        }}>
          ChainLens
        </div>

        <h1 style={{ margin: '0 0 8px', color: '#f1f5f9', textAlign: 'center', fontSize: '24px' }}>Private Beta Access</h1>
        <p style={{ margin: '0 0 22px', color: '#94a3b8', textAlign: 'center', fontSize: '13px', lineHeight: 1.6 }}>
          Enter the beta password to continue.
        </p>

        <input
          type="password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
            if (error) setError('')
          }}
          placeholder="Enter beta password"
          required
          style={inputStyle}
        />

        {error ? <p style={{ margin: '4px 0 10px', color: '#fca5a5', fontSize: '12px' }}>{error}</p> : null}

        <button type="submit" style={buttonStyle}>Enter Beta</button>

        <p style={{ margin: '14px 0 0', color: 'rgba(255,255,255,0.34)', textAlign: 'center', fontSize: '11px' }}>
          Early access for approved testers.
        </p>
      </form>
    </main>
  )
}
