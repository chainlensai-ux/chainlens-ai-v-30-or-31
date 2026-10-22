'use client'

// Homepage hero: centred headline over the design's wave background (public/home/hero-bg.webp,
// built from design/hero-reference.webp by scripts/build-hero-background.mjs). The hero keeps the
// reference's 1672x941 proportions so the background, navbar and text line up as in the design.
// Flip USE_REFERENCE_HERO in app/page.tsx to false to restore the earlier hero.
//
// Motion: the background is a single flat image, so the waves are animated with masked copies of
// it (.ref-wave) drifting a few px over the static base, plus a colour-dodge light band (.ref-sweep)
// that brightens the lit waves and leaves the black background black. Parallax (desktop, fine
// pointer only) shifts the wave copies by at most 5px via the CSS `translate` property so it
// composes with the drift `transform`. Everything is off under prefers-reduced-motion.
import Link from 'next/link'
import { useEffect, useRef } from 'react'

export default function ReferenceHero() {
  const shellRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (reduce.matches) return

    // Pause the background loops while the hero is scrolled out of view.
    const io = new IntersectionObserver(([entry]) => {
      shell.classList.toggle('ref-paused', !entry.isIntersecting)
    })
    io.observe(shell)

    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches
    let frame = 0
    let mx = 0
    let my = 0
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      mx = Math.max(-1, Math.min(1, (e.clientX / window.innerWidth - 0.5) * 2))
      my = Math.max(-1, Math.min(1, (e.clientY / window.innerHeight - 0.5) * 2))
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        shell.style.setProperty('--ref-mx', mx.toFixed(3))
        shell.style.setProperty('--ref-my', my.toFixed(3))
      })
    }
    if (finePointer) window.addEventListener('pointermove', onMove, { passive: true })

    return () => {
      io.disconnect()
      if (finePointer) window.removeEventListener('pointermove', onMove)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <>
      <section ref={shellRef} className="ref-home-shell">
        <div className="ref-bg" aria-hidden="true">
          <div className="ref-wave ref-wave-left" />
          <div className="ref-wave ref-wave-right" />
          <div className="ref-wave ref-wave-bottom" />
          <div className="ref-sweep" />
        </div>
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
        /* Wave layers: exact copies of the background (background:inherit), masked to one wave
           group each and faded out at the box edges so a few px of movement never shows a seam.
           At rest they are pixel-identical to the base underneath. */
        .ref-wave{position:absolute;inset:0;background:inherit;pointer-events:none;will-change:transform;
          translate:calc(var(--ref-mx,0) * var(--depth) * -1px) calc(var(--ref-my,0) * var(--depth) * -1px);transition:translate .9s cubic-bezier(.2,.7,.2,1);
          -webkit-mask-composite:source-in,source-in;mask-composite:intersect}
        .ref-wave{--edge-x:linear-gradient(90deg,transparent,#000 3%,#000 97%,transparent);--edge-y:linear-gradient(180deg,transparent,#000 3%,#000 97%,transparent)}
        .ref-wave-left{--depth:4;-webkit-mask-image:radial-gradient(ellipse 36% 44% at 18% 50%,#000 45%,transparent 100%),var(--edge-x),var(--edge-y);mask-image:radial-gradient(ellipse 36% 44% at 18% 50%,#000 45%,transparent 100%),var(--edge-x),var(--edge-y);animation:refDriftLeft 12.5s ease-in-out infinite alternate}
        .ref-wave-right{--depth:3;-webkit-mask-image:radial-gradient(ellipse 32% 36% at 83% 30%,#000 45%,transparent 100%),var(--edge-x),var(--edge-y);mask-image:radial-gradient(ellipse 32% 36% at 83% 30%,#000 45%,transparent 100%),var(--edge-x),var(--edge-y);animation:refDriftRight 12.5s ease-in-out infinite alternate}
        .ref-wave-bottom{--depth:5;-webkit-mask-image:radial-gradient(ellipse 44% 26% at 58% 86%,#000 45%,transparent 100%),var(--edge-x),var(--edge-y);mask-image:radial-gradient(ellipse 44% 26% at 58% 86%,#000 45%,transparent 100%),var(--edge-x),var(--edge-y);animation:refDriftBottom 12.5s ease-in-out infinite alternate}
        /* 12.5s alternate = one seamless 25s there-and-back loop with no jump. */
        @keyframes refDriftLeft{from{transform:translate3d(-2px,1px,0)}to{transform:translate3d(3px,-2px,0)}}
        @keyframes refDriftRight{from{transform:translate3d(2px,-1px,0)}to{transform:translate3d(-3px,2px,0)}}
        @keyframes refDriftBottom{from{transform:translate3d(-3px,0,0)}to{transform:translate3d(3px,-2px,0)}}
        /* Light sweep: a soft band crosses in ~3.2s, then waits off-screen; repeats every 10s.
           colour-dodge leaves black untouched and lifts the lit wave strands ~1.4x. */
        .ref-sweep{position:absolute;inset:0;overflow:hidden;pointer-events:none;mix-blend-mode:color-dodge}
        .ref-sweep::before{content:"";position:absolute;top:-10%;bottom:-10%;left:0;width:34%;background:linear-gradient(90deg,transparent,rgb(12,74,76) 50%,transparent);transform:translate3d(-160%,0,0) skewX(-22deg);will-change:transform;animation:refSweep 10s cubic-bezier(.45,0,.55,1) 1.6s infinite}
        @keyframes refSweep{0%{transform:translate3d(-160%,0,0) skewX(-22deg)}32%,100%{transform:translate3d(400%,0,0) skewX(-22deg)}}
        .ref-paused .ref-wave,.ref-paused .ref-sweep::before{animation-play-state:paused}
        /* Entrance: once, on load. Elements are stationary afterwards. */
        .ref-badge,.ref-hero h1,.ref-ctas{animation:refRise .6s cubic-bezier(.2,.7,.2,1) both}
        .ref-hero h1{animation-delay:.07s}
        .ref-ctas{animation-delay:.16s}
        @keyframes refRise{from{opacity:0;transform:translate3d(0,10px,0)}to{opacity:1;transform:none}}
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
        .ref-btn-terminal{position:relative;overflow:hidden;isolation:isolate;background:radial-gradient(120% 150% at 50% -10%,rgba(92,240,240,.24) 0%,rgba(31,214,220,.07) 48%,rgba(3,9,10,.92) 100%);border:1.5px solid #2ad8df;text-shadow:0 0 12px rgba(92,240,240,.45);box-shadow:0 0 0 4px rgba(31,214,220,.07),0 0 24px rgba(31,214,220,.38),0 10px 26px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.22),inset 0 0 18px rgba(31,214,220,.18)}
        /* Inner hairline and top gloss. */
        .ref-btn-terminal::before{content:"";position:absolute;inset:3px;border-radius:9px;border:1px solid rgba(120,245,245,.20);background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,0) 46%);pointer-events:none;z-index:-1}
        /* Light sweep on hover. */
        .ref-btn-terminal::after{content:"";position:absolute;top:0;bottom:0;left:-60%;width:40%;background:linear-gradient(105deg,transparent,rgba(170,255,252,.28),transparent);transform:skewX(-18deg);transition:left .6s ease;pointer-events:none}
        @media(hover:hover){
        .ref-btn-terminal:hover::after{left:120%}
        .ref-btn-terminal:hover{border-color:#6ff3f3;box-shadow:0 0 0 4px rgba(31,214,220,.10),0 0 32px rgba(31,214,220,.5),0 12px 28px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.28),inset 0 0 22px rgba(31,214,220,.24);transform:translateY(-1.5px)}
        .ref-btn-scan:hover{border-color:rgba(226,231,235,.6);background:rgba(12,14,16,.95);box-shadow:0 0 0 1px rgba(210,216,220,.08),0 0 16px rgba(200,208,214,.10)}
        }
        .ref-btn-scan{background:rgba(3,4,5,.94);border:2px solid rgba(190,196,200,.34)}
        .ref-btn:focus-visible{outline:2px solid #5cf0f0;outline-offset:3px}
        @media(max-width:767px){.ref-home-shell{min-height:max(600px,92svh);padding-top:72px}.ref-bg{background-position:58% center}.ref-badge{gap:10px}}
        @media(max-width:480px){.ref-ctas{flex-direction:column;width:100%;max-width:320px}.ref-btn{width:100%}}
        @media(prefers-reduced-motion:reduce){.ref-btn,.ref-btn-terminal::after{transition:none}.ref-badge,.ref-hero h1,.ref-ctas{animation:none}.ref-wave,.ref-sweep{display:none}.ref-btn:hover{transform:none}}
      `}</style>
    </>
  )
}
