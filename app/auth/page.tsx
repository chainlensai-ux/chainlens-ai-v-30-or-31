'use client';

export default function AuthPage() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#07070f] px-4">
      <div className="w-full max-w-sm bg-[#0d0d14] border border-white/10 rounded-2xl p-8 shadow-[0_0_40px_rgba(0,0,0,0.45)]">

        {/* Logo mark */}
        <div className="flex justify-center mb-6">
          <div style={{
            width: '44px', height: '44px', borderRadius: '12px',
            background: 'linear-gradient(135deg, rgba(139,92,246,0.30), rgba(45,212,191,0.20))',
            border: '1px solid rgba(139,92,246,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 20px rgba(139,92,246,0.20)',
          }}>
            <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 10px rgba(45,212,191,0.80)' }} />
          </div>
        </div>

        {/* Title */}
        <h1 className="text-center text-2xl font-semibold mb-1" style={{
          background: 'linear-gradient(95deg, #a274f8 0%, #e968b0 55%, #f472b6 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}>
          Sign In
        </h1>
        <p className="text-center text-sm mb-8" style={{ color: 'rgba(255,255,255,0.35)' }}>
          Access your ChainLens terminal
        </p>

        {/* OAuth buttons */}
        <div className="flex flex-col gap-3">

          {/* Google */}
          <button className="w-full flex items-center justify-center gap-3 rounded-xl border border-white/10 px-4 py-3 text-sm font-medium hover:bg-white/5 transition-colors" style={{ color: 'rgba(255,255,255,0.75)', background: 'rgba(255,255,255,0.03)' }}>
            <svg width="18" height="18" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Continue with Google
          </button>

          {/* Apple */}
          <button className="w-full flex items-center justify-center gap-3 rounded-xl border border-white/10 px-4 py-3 text-sm font-medium hover:bg-white/5 transition-colors" style={{ color: 'rgba(255,255,255,0.75)', background: 'rgba(255,255,255,0.03)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.4c1.38.07 2.34.74 3.17.8 1.2-.21 2.36-.91 3.64-.84 1.55.1 2.72.69 3.46 1.77-3.18 1.87-2.44 6.02.74 7.23-.62 1.37-1.41 2.71-3.01 3.92zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
            </svg>
            Continue with Apple
          </button>

          {/* Email */}
          <button className="w-full flex items-center justify-center gap-3 rounded-xl border border-white/10 px-4 py-3 text-sm font-medium hover:bg-white/5 transition-colors" style={{ color: 'rgba(255,255,255,0.75)', background: 'rgba(255,255,255,0.03)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2"/>
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
            </svg>
            Continue with Email
          </button>
        </div>

        {/* Divider */}
        <div className="h-px w-full bg-white/10 mt-6 mb-6" />

        {/* Email input */}
        <div className="mt-0">
          <input
            type="email"
            placeholder="Enter your email"
            className="w-full rounded-xl border border-white/10 bg-[#0b0b12] px-4 py-3 text-sm text-white placeholder-white/40 focus:ring-2 focus:ring-purple-500/40 focus:outline-none transition"
          />
        </div>

        {/* Forgot password */}
        <div className="flex justify-end mt-2">
          <button
            className="text-xs transition"
            style={{ color: 'rgba(255,255,255,0.40)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.70)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.40)')}
          >
            Forgot password?
          </button>
        </div>

        {/* Sign Up link */}
        <p className="text-center text-xs mt-6" style={{ color: 'rgba(255,255,255,0.35)' }}>
          {"Don't have an account? "}
          <span
            className="cursor-pointer font-medium"
            style={{
              background: 'linear-gradient(95deg, #a274f8 0%, #f472b6 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            Sign Up
          </span>
        </p>

        {/* Footer */}
        <p className="text-center text-xs mt-6" style={{ color: 'rgba(255,255,255,0.22)' }}>
          By continuing you agree to our{' '}
          <span style={{ color: 'rgba(167,139,250,0.70)', cursor: 'pointer' }}>Terms</span>
          {' '}and{' '}
          <span style={{ color: 'rgba(167,139,250,0.70)', cursor: 'pointer' }}>Privacy Policy</span>
        </p>

        {/* Gradient accent line */}
        <div className="h-px w-full bg-gradient-to-r from-teal-400 to-purple-500 mt-6" />

      </div>
    </div>
  );
}
