import { previewLoginAction } from './actions'

// searchParams is a Promise in this Next.js version (async request APIs) — verified against
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md before writing
// this, not assumed from an older Next.js convention.
export default async function PreviewLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0a0a',
        color: '#e5e5e5',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <form
        action={previewLoginAction}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
          width: '20rem',
          padding: '2rem',
          border: '1px solid #2a2a2a',
          borderRadius: '0.5rem',
          background: '#111',
        }}
      >
        <h1 style={{ fontSize: '1.1rem', margin: 0 }}>Preview Access</h1>
        <p style={{ fontSize: '0.85rem', color: '#888', margin: 0 }}>
          This is a preview deployment. Enter the password to continue.
        </p>
        <input
          type="password"
          name="password"
          placeholder="Password"
          required
          autoFocus
          style={{
            padding: '0.6rem',
            borderRadius: '0.375rem',
            border: '1px solid #333',
            background: '#000',
            color: '#e5e5e5',
          }}
        />
        <button
          type="submit"
          style={{
            padding: '0.6rem',
            borderRadius: '0.375rem',
            border: 'none',
            background: '#3b82f6',
            color: '#fff',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Enter
        </button>
        {error && (
          <p style={{ color: '#f87171', fontSize: '0.85rem', margin: 0 }}>
            Invalid password
          </p>
        )}
      </form>
    </main>
  )
}
