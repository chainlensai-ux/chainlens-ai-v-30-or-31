// Generates public/home/hero-waves.webp: the homepage hero's flowing line-wave background.
// Each wave is a "sheet": a family of thin curves that bunch together along a crest edge (bright,
// from the overlap, plus a blurred glow core) and fan out from it, fading as they spread.
//   node scripts/generate-hero-waves.mjs
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

const W = 1672
const H = 941
const SCALE = 1.6 // output 2675 x 1506

const lerp = (a, b, t) => a + (b - a) * t
const fmt = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`
const bezier = (pts) => `M${fmt(pts[0])}C${pts.slice(1).map(fmt).join(' ')}`

/**
 * crest / spread: 4 cubic control points each. Lines run from the crest (t=0) to the spread edge
 * (t=1), clustered toward the crest by `gamma`; each line's opacity falls off away from the crest.
 * `fade`: [x, opacity] stops along the sheet, used as the stroke gradient.
 */
function sheet({ id, crest, spread, lines, gamma = 1.6, color, fade, width = 0.45, opacity = 1, falloff = 0.9, glow }) {
  const paths = []
  for (let i = 0; i < lines; i += 1) {
    const t = Math.pow(i / (lines - 1), gamma)
    const pts = crest.map((p, k) => [lerp(p[0], spread[k][0], t), lerp(p[1], spread[k][1], t)])
    const a = opacity * (0.34 + 0.66 * Math.pow(1 - t, falloff))
    paths.push(`<path d="${bezier(pts)}" stroke-opacity="${a.toFixed(3)}"/>`)
  }
  const x0 = fade[0][0]
  const x1 = fade[fade.length - 1][0]
  const stops = fade.map(([x, o]) => `<stop offset="${((x - x0) / (x1 - x0)).toFixed(3)}" stop-color="${color}" stop-opacity="${o}"/>`).join('')
  const defs = `<linearGradient id="g-${id}" gradientUnits="userSpaceOnUse" x1="${x0}" y1="0" x2="${x1}" y2="0">${stops}</linearGradient>`
  const glowPath = glow
    ? `<path d="${bezier(crest)}" fill="none" stroke="url(#g-${id})" stroke-width="${glow.width}" opacity="${glow.opacity}" filter="url(#blur-${glow.blur})"/>`
      + `<path d="${bezier(crest)}" fill="none" stroke="url(#g-${id})" stroke-width="${glow.core ?? 1.6}" opacity="${glow.coreOpacity ?? 0.9}" filter="url(#blur-s)"/>`
    : ''
  return { defs, body: `${glowPath}<g fill="none" stroke="url(#g-${id})" stroke-width="${width}" stroke-linecap="round">${paths.join('')}</g>` }
}

const MINT = '#1fd8dc'
const MINT_BRIGHT = '#8ff6f2'
const SILVER = '#d9dee2'

const sheets = [
  // Upper-left silver sheet: crest sweeping from the left edge down toward the centre.
  sheet({
    id: 'a-up', lines: 130, color: SILVER, opacity: 0.6,
    crest: [[-30, 150], [210, 205], [400, 320], [640, 405]],
    spread: [[-30, 40], [200, 70], [390, 230], [660, 370]],
    fade: [[0, 0.05], [140, 0.5], [430, 0.6], [560, 0.3], [660, 0]],
  }),
  sheet({
    id: 'a-down', lines: 90, color: SILVER, opacity: 0.5,
    crest: [[-30, 152], [210, 207], [400, 322], [640, 406]],
    spread: [[-30, 330], [200, 320], [400, 390], [660, 440]],
    fade: [[0, 0.04], [160, 0.32], [450, 0.42], [660, 0]],
  }),
  // Lower-left mint sheet: a bright glowing crest with the sheet falling away below it.
  sheet({
    id: 'b-down', lines: 140, color: MINT, opacity: 0.75, gamma: 1.9,
    crest: [[-30, 572], [150, 572], [300, 616], [500, 668]],
    spread: [[-30, 790], [170, 730], [340, 720], [560, 720]],
    fade: [[0, 0.25], [120, 0.95], [380, 0.9], [470, 0.4], [560, 0]],
    glow: { width: 44, opacity: 0.8, blur: 'l', core: 2.2, coreOpacity: 0.95 },
  }),
  sheet({
    id: 'b-up', lines: 60, color: MINT, opacity: 0.55,
    crest: [[-30, 570], [150, 570], [300, 614], [500, 666]],
    spread: [[-30, 500], [150, 525], [310, 580], [520, 630]],
    fade: [[0, 0.15], [140, 0.6], [400, 0.5], [540, 0]],
  }),
  sheet({
    id: 'b-tip', lines: 10, color: MINT_BRIGHT, opacity: 0.9, gamma: 1, falloff: 0.5, width: 0.6,
    crest: [[-30, 571], [150, 571], [300, 615], [470, 660]],
    spread: [[-30, 578], [150, 577], [300, 620], [470, 663]],
    fade: [[0, 0.1], [150, 0.9], [360, 0.85], [480, 0]],
  }),
  // Right mint sheet: crest arching across the upper right, fanning up into the corner.
  sheet({
    id: 'c-up', lines: 150, color: MINT, opacity: 0.7, gamma: 1.9,
    crest: [[1030, 380], [1250, 255], [1460, 282], [1712, 352]],
    spread: [[1060, 350], [1290, 175], [1500, 95], [1712, 120]],
    fade: [[1030, 0], [1200, 0.25], [1420, 0.6], [1600, 0.85], [1672, 0.95]],
    glow: { width: 48, opacity: 0.85, blur: 'l', core: 2.4, coreOpacity: 0.95 },
  }),
  sheet({
    id: 'c-down', lines: 80, color: MINT, opacity: 0.55,
    crest: [[1030, 382], [1250, 258], [1460, 285], [1712, 355]],
    spread: [[1060, 410], [1270, 340], [1460, 400], [1712, 480]],
    fade: [[1030, 0], [1250, 0.25], [1500, 0.5], [1672, 0.6]],
  }),
  sheet({
    id: 'c-tip', lines: 10, color: MINT_BRIGHT, opacity: 0.9, gamma: 1, falloff: 0.5, width: 0.6,
    crest: [[1120, 320], [1290, 262], [1470, 284], [1712, 352]],
    spread: [[1120, 324], [1290, 268], [1470, 290], [1712, 358]],
    fade: [[1120, 0], [1350, 0.45], [1600, 0.9], [1672, 1]],
  }),
  // Silver sheet sweeping across the right middle, under the mint one.
  sheet({
    id: 'd', lines: 110, color: SILVER, opacity: 0.42,
    crest: [[1080, 560], [1300, 480], [1490, 445], [1712, 450]],
    spread: [[1110, 600], [1300, 570], [1500, 570], [1712, 620]],
    fade: [[1080, 0], [1280, 0.3], [1500, 0.45], [1672, 0.3]],
  }),
  // Bottom mint rim over the dark hill, centre right.
  sheet({
    id: 'e', lines: 120, color: MINT, opacity: 0.6, gamma: 1.9,
    crest: [[820, 905], [1010, 842], [1210, 822], [1500, 862]],
    spread: [[820, 945], [1060, 905], [1300, 905], [1620, 960]],
    fade: [[820, 0], [990, 0.55], [1200, 0.75], [1400, 0.35], [1560, 0]],
    glow: { width: 20, opacity: 0.6, blur: 'm', core: 1.6, coreOpacity: 0.7 },
  }),
  // Faint silver rim on the bottom-left hill.
  sheet({
    id: 'f', lines: 60, color: SILVER, opacity: 0.35,
    crest: [[-30, 800], [220, 760], [470, 800], [760, 900]],
    spread: [[-30, 940], [240, 880], [480, 900], [760, 945]],
    fade: [[0, 0.1], [250, 0.3], [600, 0.15], [760, 0]],
  }),
]

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W * SCALE)}" height="${Math.round(H * SCALE)}" viewBox="0 0 ${W} ${H}">
<defs>
${sheets.map((s) => s.defs).join('\n')}
<filter id="blur-l" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="20"/></filter>
<filter id="blur-m" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="12"/></filter>
<filter id="blur-s" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="2.2"/></filter>
<radialGradient id="mist-l" cx="260" cy="610" r="230" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${MINT}" stop-opacity="0.10"/><stop offset="1" stop-color="${MINT}" stop-opacity="0"/></radialGradient>
<radialGradient id="mist-r" cx="1620" cy="330" r="260" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${MINT}" stop-opacity="0.10"/><stop offset="1" stop-color="${MINT}" stop-opacity="0"/></radialGradient>
<radialGradient id="mist-b" cx="1150" cy="850" r="240" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${MINT}" stop-opacity="0.07"/><stop offset="1" stop-color="${MINT}" stop-opacity="0"/></radialGradient>
<linearGradient id="hill" x1="0" y1="760" x2="0" y2="941" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0c1213"/><stop offset="1" stop-color="#020303"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="#020303"/>
<path d="M800 941 C1010 846 1210 824 1500 864 C1600 878 1660 870 1712 860 L1712 941 Z" fill="url(#hill)"/>
<path d="M-30 941 L-30 806 C220 762 470 802 760 941 Z" fill="url(#hill)" opacity="0.8"/>
<rect width="${W}" height="${H}" fill="url(#mist-l)"/>
<rect width="${W}" height="${H}" fill="url(#mist-r)"/>
<rect width="${W}" height="${H}" fill="url(#mist-b)"/>
${sheets.map((s) => s.body).join('\n')}
</svg>`

mkdirSync('public/home', { recursive: true })
await sharp(Buffer.from(svg)).webp({ quality: 84, effort: 6 }).toFile('public/home/hero-waves.webp')
const meta = await sharp('public/home/hero-waves.webp').metadata()
console.log('public/home/hero-waves.webp', meta.width, 'x', meta.height)
