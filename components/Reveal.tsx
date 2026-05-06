'use client'

import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'

type RevealProps = {
  children: ReactNode
  delayMs?: number
  durationMs?: number
  y?: number
  once?: boolean
  className?: string
  style?: CSSProperties
}

export default function Reveal({
  children,
  delayMs = 0,
  durationMs = 760,
  y = 22,
  once = true,
  className,
  style,
}: RevealProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updateMotion = () => setReduceMotion(media.matches)
    updateMotion()
    media.addEventListener('change', updateMotion)

    return () => media.removeEventListener('change', updateMotion)
  }, [])

  useEffect(() => {
    if (reduceMotion) {
      setIsVisible(true)
      return
    }

    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          if (once) observer.unobserve(entry.target)
        } else if (!once) {
          setIsVisible(false)
        }
      },
      { threshold: 0.18, rootMargin: '0px 0px -8% 0px' }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [once, reduceMotion])

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translate3d(0,0,0)' : `translate3d(0, ${y}px, 0)`,
        transition: reduceMotion
          ? 'none'
          : `opacity ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1) ${delayMs}ms, transform ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1) ${delayMs}ms`,
        willChange: reduceMotion ? 'auto' : 'opacity, transform',
        ...style,
      }}
    >
      {children}
    </div>
  )
}
