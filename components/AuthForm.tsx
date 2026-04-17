'use client';

import { useState } from 'react';
import { signIn, signUp } from '@/lib/auth';
import Image from 'next/image';

export default function AuthForm() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const fn = mode === 'signin' ? signIn : signUp;
    const { error } = await fn(email, password);

    if (error) setError(error.message);
    setLoading(false);
  }

  return (
    <div className="w-full max-w-sm mx-auto p-6 rounded-xl bg-[#0f0f0f] border border-white/10 shadow-xl">
      <div className="flex justify-center mb-4">
        <Image src="/chainlens-logo.png" alt="ChainLens" width={48} height={48} />
      </div>

      <h2 className="text-center text-2xl font-semibold mb-6">
        {mode === 'signin' ? 'Sign In' : 'Create Account'}
      </h2>

      <div className="space-y-3 mb-4">
        <button className="w-full p-2 rounded bg-white/10 hover:bg-white/20 transition flex items-center justify-center gap-2">
          <Image src="/google.svg" alt="Google" width={20} height={20} />
          Continue with Google
        </button>

        <button className="w-full p-2 rounded bg-white/10 hover:bg-white/20 transition flex items-center justify-center gap-2">
          <Image src="/github.svg" alt="GitHub" width={20} height={20} />
          Continue with GitHub
        </button>
      </div>

      <div className="flex items-center gap-3 my-4">
        <div className="h-px flex-1 bg-white/10" />
        <span className="text-xs text-white/40">OR</span>
        <div className="h-px flex-1 bg-white/10" />
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="email"
          placeholder="Email"
          className="w-full p-2 rounded bg-black/20 border border-white/10"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          type="password"
          placeholder="Password"
          className="w-full p-2 rounded bg-black/20 border border-white/10"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full p-2 rounded bg-blue-600 hover:bg-blue-700 transition"
        >
          {loading ? 'Loading...' : mode === 'signin' ? 'Sign In' : 'Sign Up'}
        </button>
      </form>

      <div className="flex justify-between mt-3 text-sm">
        <button className="text-blue-300 hover:underline">Forgot password?</button>
      </div>

      <button
        onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        className="mt-4 text-sm text-blue-300 underline w-full text-center"
      >
        {mode === 'signin'
          ? "Don't have an account? Sign Up"
          : 'Already have an account? Sign In'}
      </button>
    </div>
  );
}
