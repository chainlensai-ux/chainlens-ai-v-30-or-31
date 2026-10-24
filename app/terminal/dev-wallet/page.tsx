import Link from 'next/link'

export default function DevWalletRetiredPage() {
  return (
    <main
      className="min-h-dvh overflow-hidden px-5 py-8 text-white sm:px-8 lg:px-10"
      style={{
        background:
          'radial-gradient(circle at 20% 15%, rgba(31,214,220,0.18), transparent 28%), radial-gradient(circle at 80% 12%, rgba(194,197,200,0.18), transparent 30%), linear-gradient(135deg, #04070a 0%, #0d1013 48%, #05080b 100%)',
      }}
    >
      <section className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-5xl items-center justify-center">
        <div
          className="relative w-full overflow-hidden rounded-[28px] border p-6 shadow-2xl sm:p-8 lg:p-10"
          style={{
            background: 'linear-gradient(145deg, rgba(13,16,19,0.88), rgba(10,13,16,0.76))',
            borderColor: 'rgba(158,161,164,0.18)',
            boxShadow: '0 28px 90px rgba(0,0,0,0.46), inset 0 1px 0 rgba(255,255,255,0.08)',
            backdropFilter: 'blur(22px)',
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl"
            style={{ background: 'rgba(194,197,200,0.20)' }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-28 -left-20 h-72 w-72 rounded-full blur-3xl"
            style={{ background: 'rgba(31,214,220,0.18)' }}
          />

          <div className="relative grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
            <div>
              <div
                className="mb-5 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.22em]"
                style={{
                  color: '#62f1f1',
                  background: 'rgba(31,214,220,0.08)',
                  borderColor: 'rgba(31,214,220,0.24)',
                }}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#1fd6dc', boxShadow: '0 0 14px #1fd6dc' }} />
                CORTEX Dev Control
              </div>

              <h1 className="max-w-3xl text-3xl font-semibold tracking-[-0.03em] text-slate-50 sm:text-4xl lg:text-5xl">
                Dev Wallet Detector is now part of Token Scanner
              </h1>

              <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
                CORTEX Dev Control now lives inside Token Scanner with deployer detection, linked wallets, supply influence, Cluster Map, behavior intelligence, and watch planning.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link
                  href="/terminal/token-scanner"
                  className="inline-flex items-center justify-center rounded-2xl px-5 py-3 text-sm font-bold transition hover:scale-[1.01] active:scale-[0.99]"
                  style={{
                    color: '#ffffff',
                    border: '1.5px solid #2ad8df',
                    background: 'radial-gradient(120% 150% at 50% -10%, rgba(92,240,240,0.26) 0%, rgba(31,214,220,0.08) 48%, rgba(3,9,10,0.92) 100%)',
                    boxShadow: '0 0 0 3px rgba(31,214,220,0.07), 0 0 22px rgba(31,214,220,0.28), inset 0 1px 0 rgba(255,255,255,0.18)',
                  }}
                >
                  Open Token Scanner
                  <span className="ml-2" aria-hidden="true">→</span>
                </Link>
                <p className="text-sm text-slate-400">
                  Scan a token, then open the Dev Control tab.
                </p>
              </div>
            </div>

            <div
              className="rounded-[24px] border p-5"
              style={{
                background: 'linear-gradient(180deg, rgba(20,23,26,0.74), rgba(20,23,26,0.36))',
                borderColor: 'rgba(158,161,164,0.16)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
              }}
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-[0.22em] text-slate-500">Now located in</span>
                <span className="rounded-full border border-purple-400/30 bg-purple-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-purple-200">
                  Token Scanner
                </span>
              </div>

              <div className="space-y-3">
                {[
                  'Deployer detection',
                  'Linked wallet review',
                  'Supply influence context',
                  'Cluster Map and behavior intelligence',
                  'Watch planning after scan',
                ].map((item) => (
                  <div key={item} className="flex items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.03] px-4 py-3 text-sm text-slate-200">
                    <span className="h-2 w-2 rounded-full bg-teal-300 shadow-[0_0_14px_rgba(31,214,220,0.75)]" />
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
