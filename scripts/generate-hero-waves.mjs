// Generates public/home/hero-waves.webp: the homepage hero's flowing line-wave background.
// Each "ribbon" is a family of thin curves interpolated between two cubic-bezier edges, with a
// slight twist so the lines fan like silk; a few blurred strokes give the mint glow.
//   node scripts/generate-hero-waves.mjs
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

const W = 1672
const H = 941
const SCALE = 1.6 // output 2675 x 1506

const lerp = (a, b, t) => a + (b - a) * t
const lerpPt = (p, q, t) => [lerp(p[0], q[0], t), lerp(p[1], q[1], t)]

/**
 * top/bottom: 4 control points each. twist: extra offset applied to the middle control points,
 * strongest for the centre lines, so the family bulges like a ribbon.
 */
function ribbon({ id, top, bottom, lines, twist = [0, 0], width = 0.7, gradient, glow }) {
  const paths = []
  for (let i = 0; i < lines; i += 1) {
    const t = i / (lines - 1)
    const bulge = Math.sin(t * Math.PI)
    const pts = top.map((p, k) => {
      const [x, y] = lerpPt(p, bottom[k], t)
      return k === 1 || k === 2 ? [x + twist[0] * bulge * (k === 1 ? 1 : -0.6), y + twist[1] * bulge * (k === 1 ? 1 : -0.6)] : [x, y]
    })
    const d = `M${pts[0].map((v) => v.toFixed(1)).join(' ')}C${pts.slice(1).map((p) => p.map((v) => v.toFixed(1)).join(' ')).join(' ')}`
    paths.push(`<path d="${d}"/>`)
  }
  const stops = gradient.stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('')
  const grad = `<linearGradient id="g-${id}" gradientUnits="userSpaceOnUse" x1="${gradient.from[0]}" y1="${gradient.from[1]}" x2="${gradient.to[0]}" y2="${gradient.to[1]}">${stops}</linearGradient>`
  const glowPaths = glow
    ? (() => {
        const mid = top.map((p, k) => lerpPt(p, bottom[k], glow.at ?? 0.5))
        const d = `M${mid[0].join(' ')}C${mid.slice(1).map((p) => p.join(' ')).join(' ')}`
        return `<path d="${d}" fill="none" stroke="url(#g-${id})" stroke-width="${glow.width}" opacity="${glow.opacity}" filter="url(#blur-${glow.blur})"/>`
      })()
    : ''
  return {
    defs: grad,
    body: `${glowPaths}<g fill="none" stroke="url(#g-${id})" stroke-width="${width}" stroke-linecap="round">${paths.join('')}</g>`,
  }
}

const MINT = '#2fe6cf'
const MINT_SOFT = '#1fb7a6'
const GREY = '#c9d1d6'

const ribbons = [
  // Upper-left silver ribbon, sweeping down toward the centre and fading before it gets there.
  ribbon({
    id: 'a', lines: 56, width: 0.45, twist: [-60, 90],
    top: [[-40, 70], [250, 150], [430, 300], [780, 410]],
    bottom: [[-40, 330], [220, 300], [430, 390], [780, 470]],
    gradient: { from: [0, 0], to: [780, 0], stops: [[0, GREY, 0.07], [0.22, GREY, 0.34], [0.55, GREY, 0.28], [0.85, GREY, 0]] },
  }),
  // Lower-left mint ribbon with a bright crest.
  ribbon({
    id: 'b', lines: 52, width: 0.5, twist: [40, -50],
    top: [[-40, 510], [170, 540], [340, 600], [640, 660]],
    bottom: [[-40, 700], [160, 650], [340, 690], [640, 730]],
    gradient: { from: [0, 0], to: [640, 0], stops: [[0, MINT_SOFT, 0.12], [0.3, MINT, 0.7], [0.6, MINT, 0.42], [0.92, MINT, 0]] },
    glow: { at: 0.22, width: 30, opacity: 0.6, blur: 'l' },
  }),
  // Bright edge lines along the left crest.
  ribbon({
    id: 'b1', lines: 8, width: 0.9,
    top: [[-40, 560], [170, 560], [330, 615], [560, 676]],
    bottom: [[-40, 590], [170, 582], [330, 630], [560, 684]],
    gradient: { from: [0, 0], to: [560, 0], stops: [[0, MINT, 0.1], [0.4, '#7ff5e4', 0.85], [0.75, MINT, 0.4], [1, MINT, 0]] },
  }),
  // Faint second layer under the left mint ribbon.
  ribbon({
    id: 'b2', lines: 30, width: 0.45, twist: [0, 30],
    top: [[-40, 620], [200, 620], [380, 700], [660, 770]],
    bottom: [[-40, 780], [200, 740], [380, 760], [660, 800]],
    gradient: { from: [0, 0], to: [660, 0], stops: [[0, MINT_SOFT, 0.06], [0.4, MINT_SOFT, 0.18], [1, MINT_SOFT, 0]] },
  }),
  // Right mint ribbon rising to the top-right edge.
  ribbon({
    id: 'c', lines: 64, width: 0.5, twist: [-40, 70],
    top: [[1000, 500], [1250, 400], [1440, 120], [1712, 20]],
    bottom: [[1000, 560], [1300, 480], [1490, 330], [1712, 400]],
    gradient: { from: [1000, 0], to: [1672, 0], stops: [[0, MINT, 0], [0.4, MINT_SOFT, 0.2], [0.78, MINT, 0.55], [1, MINT, 0.8]] },
    glow: { at: 0.85, width: 26, opacity: 0.65, blur: 'l' },
  }),
  // Bright edge lines along the right crest.
  ribbon({
    id: 'c1', lines: 8, width: 0.9,
    top: [[1080, 520], [1330, 450], [1500, 300], [1712, 335]],
    bottom: [[1080, 528], [1340, 462], [1510, 318], [1712, 362]],
    gradient: { from: [1080, 0], to: [1672, 0], stops: [[0, MINT, 0], [0.5, MINT, 0.35], [1, '#7ff5e4', 0.9]] },
  }),
  // Silver sweep across the right middle.
  ribbon({
    id: 'd', lines: 44, width: 0.45, twist: [0, 40],
    top: [[1000, 600], [1230, 480], [1440, 430], [1712, 380]],
    bottom: [[1000, 640], [1280, 590], [1480, 530], [1712, 600]],
    gradient: { from: [1000, 0], to: [1672, 0], stops: [[0, GREY, 0], [0.45, GREY, 0.12], [1, GREY, 0.07]] },
  }),
  // Bottom-right mint crest over the dark hill.
  ribbon({
    id: 'e', lines: 44, width: 0.5, twist: [0, -30],
    top: [[820, 980], [1100, 840], [1330, 818], [1712, 790]],
    bottom: [[820, 1000], [1150, 930], [1420, 900], [1712, 920]],
    gradient: { from: [820, 0], to: [1672, 0], stops: [[0, MINT, 0], [0.38, MINT, 0.5], [0.7, MINT_SOFT, 0.26], [1, MINT_SOFT, 0.1]] },
    glow: { at: 0.06, width: 20, opacity: 0.5, blur: 'm' },
  }),
  // Bottom-left dark hill edge.
  ribbon({
    id: 'f', lines: 30, width: 0.45, twist: [0, 20],
    top: [[-40, 830], [260, 770], [520, 860], [860, 980]],
    bottom: [[-40, 960], [260, 900], [520, 950], [860, 1000]],
    gradient: { from: [0, 0], to: [860, 0], stops: [[0, GREY, 0.04], [0.4, MINT_SOFT, 0.12], [1, GREY, 0]] },
  }),
]

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W * SCALE)}" height="${Math.round(H * SCALE)}" viewBox="0 0 ${W} ${H}">
<defs>
${ribbons.map((r) => r.defs).join('\n')}
<filter id="blur-l" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="22"/></filter>
<filter id="blur-m" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
<radialGradient id="haze-l" cx="300" cy="640" r="320" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${MINT}" stop-opacity="0.14"/><stop offset="1" stop-color="${MINT}" stop-opacity="0"/></radialGradient>
<radialGradient id="haze-r" cx="1600" cy="330" r="360" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${MINT}" stop-opacity="0.13"/><stop offset="1" stop-color="${MINT}" stop-opacity="0"/></radialGradient>
<radialGradient id="haze-b" cx="1250" cy="860" r="380" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${MINT}" stop-opacity="0.09"/><stop offset="1" stop-color="${MINT}" stop-opacity="0"/></radialGradient>
<radialGradient id="vignette" cx="836" cy="470" r="1000" gradientUnits="userSpaceOnUse"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></radialGradient>
<linearGradient id="hill-r" x1="0" y1="780" x2="0" y2="941" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0b1415"/><stop offset="1" stop-color="#030505"/></linearGradient>
<linearGradient id="hill-l" x1="0" y1="800" x2="0" y2="941" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0a0f10"/><stop offset="1" stop-color="#030404"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="#040506"/>
<rect width="${W}" height="${H}" fill="url(#haze-l)"/>
<rect width="${W}" height="${H}" fill="url(#haze-r)"/>
<rect width="${W}" height="${H}" fill="url(#haze-b)"/>
<path d="M820 941 C1100 850 1330 822 1712 800 L1712 941 Z" fill="url(#hill-r)" opacity="0.9"/>
<path d="M-40 941 L-40 840 C260 780 520 870 860 941 Z" fill="url(#hill-l)" opacity="0.9"/>
${ribbons.map((r) => r.body).join('\n')}
<rect width="${W}" height="${H}" fill="url(#vignette)"/>
</svg>`

mkdirSync('public/home', { recursive: true })
await sharp(Buffer.from(svg)).webp({ quality: 82, effort: 6 }).toFile('public/home/hero-waves.webp')
const meta = await sharp('public/home/hero-waves.webp').metadata()
console.log('public/home/hero-waves.webp', meta.width, 'x', meta.height)
