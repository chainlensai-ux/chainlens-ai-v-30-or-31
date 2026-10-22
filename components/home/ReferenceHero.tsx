'use client'

// Homepage hero: centred headline over the design's wave background (public/home/hero-bg.webp,
// built from design/hero-reference.webp by scripts/build-hero-background.mjs). The hero keeps the
// reference's 1672x941 proportions so the background, navbar and text line up as in the design.
// Flip USE_REFERENCE_HERO in app/page.tsx to false to restore the earlier hero.
import Link from 'next/link'

export default function ReferenceHero() {
  return (
    <>
      <section className="ref-home-shell">
        <div className="ref-bg" aria-hidden="true" />
        <main className="ref-hero">
          <div className="ref-badge"><i aria-hidden="true" /><span>Powered by <b>Cortex Engine</b></span></div>
          <h1>
            <span className="ref-line ref-line-1" data-text={'Don\u2019t ape'}>Don&rsquo;t ape</span>
            <span className="ref-line ref-line-2" data-text="blind.">blind.</span>
          </h1>
          <div className="ref-ctas">
            <Link className="ref-btn ref-btn-terminal" href="/terminal">Launch Terminal</Link>
            <Link className="ref-btn ref-btn-scan" href="/terminal/token-scanner">Scan Token Free</Link>
          </div>
        </main>
      </section>
      <style>{`
        body:has(.ref-home-shell){margin:0}
        body:has(.ref-home-shell) .nav-outer{position:fixed!important;left:0;right:0}
        @media(min-width:1024px){body:has(.ref-home-shell) .nav-outer{padding-top:clamp(36px,4.2vw,70px)!important}}
        .ref-home-shell{--mint:#1fd6dc;position:relative;min-height:max(600px,56.28vw);padding-top:3.3vw;display:flex;align-items:center;justify-content:center;background:#020303;overflow:hidden;color:#fff;isolation:isolate}
        .ref-bg{position:absolute;inset:0;z-index:-1;background:#020303 url('/home/hero-bg.webp') center top/cover no-repeat}
        .ref-bg::after{content:"";position:absolute;inset:auto 0 0 0;height:90px;background:linear-gradient(180deg,transparent,#020303)}
        .ref-hero{display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 20px;font-family:var(--font-jakarta,'Plus Jakarta Sans',sans-serif)}
        .ref-badge{display:inline-flex;align-items:center;gap:14px;margin-bottom:clamp(22px,2.6vw,34px);font-size:clamp(13px,1.05vw,17px);font-weight:500;letter-spacing:.035em;text-transform:uppercase;color:rgba(206,212,216,.62)}
        .ref-badge i{width:clamp(12px,1vw,16px);height:clamp(12px,1vw,16px);border-radius:50%;background:var(--mint);box-shadow:0 0 12px rgba(31,214,220,.6)}
        .ref-badge b{font-weight:600;color:var(--mint)}
        .ref-hero h1{margin:0;display:flex;flex-direction:column;align-items:center;font-family:var(--font-sora,'Sora',sans-serif);font-weight:800;font-size:clamp(50px,6.2vw,106px);line-height:1.05;letter-spacing:-.01em}
        /* Each line: solid text with a same-colour stroke for extra weight (no visible seams), and
           the chrome gradient laid over it as a copy clipped to the glyphs. */
        .ref-line{position:relative;-webkit-text-stroke:.024em currentColor}
        .ref-line::after{content:attr(data-text);content:attr(data-text) / "";position:absolute;inset:0;-webkit-text-stroke:0;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;pointer-events:none}
        .ref-line-1{color:#e4e8ea;filter:drop-shadow(0 2px 14px rgba(0,0,0,.6))}
        .ref-line-1::after{background-image:linear-gradient(172deg,#ffffff 0%,#f4f6f7 38%,#c4cacf 62%,#eef1f2 82%,#d5dade 100%)}
        .ref-line-2{color:#19c9d1;filter:drop-shadow(0 0 26px rgba(31,214,220,.24))}
        .ref-line-2::after{background-image:linear-gradient(172deg,#62f1f1 0%,#1fd6dc 42%,#12bccb 70%,#28d9de 100%)}
        .ref-ctas{display:flex;gap:clamp(14px,1.4vw,24px);margin-top:clamp(36px,3.9vw,64px)}
        .ref-btn{display:inline-flex;align-items:center;justify-content:center;width:clamp(200px,15.2vw,256px);height:clamp(52px,3.75vw,62px);border-radius:12px;color:#fff;text-decoration:none;font-size:clamp(15px,1.1vw,18.5px);font-weight:600;letter-spacing:.005em;transition:border-color .18s ease,box-shadow .18s ease,background .18s ease,transform .18s ease}
        .ref-btn-terminal{background:linear-gradient(180deg,rgba(31,214,220,.06),rgba(31,214,220,.015)),rgba(4,10,11,.78);border:2px solid #22d3da;box-shadow:0 0 16px rgba(31,214,220,.35),0 0 2px rgba(31,214,220,.6),inset 0 0 12px rgba(31,214,220,.14)}
        .ref-btn-terminal:hover{border-color:#5cf0f0;box-shadow:0 0 24px rgba(31,214,220,.45),0 0 2px rgba(31,214,220,.7),inset 0 0 14px rgba(31,214,220,.18);transform:translateY(-1px)}
        .ref-btn-scan{background:rgba(3,4,5,.94);border:2px solid rgba(190,196,200,.34)}
        .ref-btn-scan:hover{border-color:rgba(220,226,230,.5);background:rgba(12,14,16,.95);transform:translateY(-1px)}
        .ref-btn:focus-visible{outline:2px solid #5cf0f0;outline-offset:3px}
        @media(max-width:767px){.ref-home-shell{min-height:max(600px,92svh);padding-top:72px}.ref-bg{background-position:58% center}.ref-badge{gap:10px}}
        @media(max-width:480px){.ref-ctas{flex-direction:column;width:100%;max-width:320px}.ref-btn{width:100%}}
        @media(prefers-reduced-motion:reduce){.ref-btn{transition:none}}
      `}</style>
    </>
  )
}
