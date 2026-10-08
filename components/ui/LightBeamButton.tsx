'use client'

// LightBeamButton — a CTA with a light beam rotating around its border (CSS @property angle animation,
// GPU-friendly), an inner glow on hover, and framer-motion hover/tap. Adapted for ChainLens: renders a Next
// <Link> when given `href` (else a <button>), uses the brand pink → purple → mint beam by default, and stops
// the beam for prefers-reduced-motion. Sizing/typography come from the caller's className.
import Link from 'next/link'
import { motion } from 'framer-motion'
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

const MotionLink = motion.create(Link)

type CommonProps = {
  children: ReactNode
  className?: string
  /** Three beam colors: leading edge, core, trailing edge. */
  gradientColors?: [string, string, string]
  /** Corner radius of the beam border (match the caller's border-radius). */
  radius?: number | string
}

export type LightBeamButtonProps = CommonProps & (
  | { href: string; onClick?: never; type?: never; disabled?: never }
  | { href?: undefined; onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean }
)

const DEFAULT_COLORS: [string, string, string] = ['#E053C2', '#B666F3', '#53F3C3']

const hover = { scale: 1.02, y: -2 }
const tap = { scale: 0.98, y: 0 }

export function LightBeamButton(props: LightBeamButtonProps) {
  const { children, className, gradientColors = DEFAULT_COLORS, radius = 13 } = props
  const [lead, core, trail] = gradientColors
  const style = {
    '--lbb-radius': typeof radius === 'number' ? `${radius}px` : radius,
    '--lbb-beam': `conic-gradient(from var(--lbb-angle), transparent 0%, ${lead} 30%, ${core} 42%, ${trail} 50%, transparent 60%, transparent 100%)`,
    '--lbb-glow': core,
  } as CSSProperties

  const content = (
    <>
      <span className="lbb-beam" aria-hidden="true" />
      <span className="lbb-fill" aria-hidden="true" />
      <span className="lbb-shine" aria-hidden="true" />
      <span className="lbb-label">{children}</span>
    </>
  )

  return (
    <>
      <style>{LIGHT_BEAM_CSS}</style>
      {props.href != null ? (
        <MotionLink href={props.href} className={cn('lbb', className)} style={style} whileHover={hover} whileTap={tap}>
          {content}
        </MotionLink>
      ) : (
        <motion.button type={props.type ?? 'button'} onClick={props.onClick} disabled={props.disabled} className={cn('lbb', className)} style={style} whileHover={hover} whileTap={tap}>
          {content}
        </motion.button>
      )}
    </>
  )
}

const LIGHT_BEAM_CSS = `
@property --lbb-angle{syntax:"<angle>";initial-value:0deg;inherits:false}
@keyframes lbb-spin{to{--lbb-angle:360deg}}
.lbb{position:relative;isolation:isolate;overflow:hidden;border:0;border-radius:var(--lbb-radius);background:transparent;cursor:pointer;
  box-shadow:0 0 22px -6px color-mix(in srgb,var(--lbb-glow) 45%,transparent);transition:box-shadow .25s ease}
.lbb:hover{box-shadow:0 12px 34px -8px color-mix(in srgb,var(--lbb-glow) 60%,transparent),0 0 26px -6px rgba(83,243,195,.35)}
.lbb:focus-visible{outline:2px solid #53F3C3;outline-offset:3px}
.lbb-beam,.lbb-fill,.lbb-shine{position:absolute;pointer-events:none;border-radius:inherit}
.lbb-beam{inset:0;z-index:-3;background:var(--lbb-beam),rgba(182,102,243,.28);animation:lbb-spin 2.6s linear infinite}
.lbb-fill{inset:1.5px;z-index:-2;border-radius:calc(var(--lbb-radius) - 1.5px);background:linear-gradient(180deg,#0b0f1d,#070a14)}
.lbb-shine{inset:0;z-index:-1;opacity:0;transition:opacity .45s ease;
  background:radial-gradient(circle at 50% 0%,color-mix(in srgb,var(--lbb-glow) 22%,transparent) 0%,transparent 65%)}
.lbb:hover .lbb-shine{opacity:1}
.lbb-label{position:relative;z-index:1;display:inline-flex;align-items:center;gap:inherit}
@media (prefers-reduced-motion:reduce){.lbb-beam{animation:none}}
`

export default LightBeamButton
