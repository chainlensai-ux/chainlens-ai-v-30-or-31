export default function BetaPage() {
  return (
    <main style={{
      minHeight: '100vh',
      background: '#04060d',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <p style={{
        margin: 0,
        fontSize: 'clamp(28px, 6vw, 56px)',
        fontWeight: 800,
        letterSpacing: '-.02em',
        color: '#f1f5f9',
        textAlign: 'center',
        fontFamily: 'var(--font-inter, Inter, sans-serif)',
      }}>
        V3 Beta is over.
      </p>
    </main>
  )
}
