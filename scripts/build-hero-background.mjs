// Builds public/home/hero-bg.webp from the homepage design reference (design/hero-reference.webp,
// 1672x941): the reference's baked-in navbar, badge, headline and buttons are painted out so the
// live ones can sit on top. Each painted region is filled column by column, blending the
// background just above and below it, then feathered into the original.
//   node scripts/build-hero-background.mjs
import sharp from 'sharp'

const SRC = 'design/hero-reference.webp'
const OUT = 'public/home/hero-bg.webp'
const OUT_SCALE = 1.5 // 2508 x 1412; lanczos upscale so it stays sharp on wide / high-DPR screens
const FEATHER = 10

// [x0, y0, x1, y1] in reference pixels, padded to include each element's glow.
const REGIONS = [
  [126, 58, 1546, 160], // navbar pill
  [590, 296, 1096, 600], // badge and headline
  [556, 612, 1116, 708], // buttons
]
// How far (px) a wave tip at a region's left/right edge carries into the fill before fading out.
const SIDE_TAPER = 36
const SAMPLE_SMOOTH = 6 // horizontal box-smoothing radius of the above/below samples (no streaks)

const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true })
const { width: W, height: H, channels: C } = info
const filled = Buffer.from(data)
const mask = new Float32Array(W * H) // 1 inside a painted region
const px = (x, y, c) => data[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * C + c]

for (const [x0, y0, x1, y1] of REGIONS) {
  // A few rows just outside the region, smoothed horizontally.
  const rowAvg = (x, y, dir) => [0, 1, 2].map((c) => {
    let sum = 0; let n = 0
    for (let dx = -SAMPLE_SMOOTH; dx <= SAMPLE_SMOOTH; dx += 1) for (let k = 0; k < 4; k += 1) { sum += px(x + dx, y + dir * k, c); n += 1 }
    return sum / n
  })
  const colAvg = (x, y, dir) => [0, 1, 2].map((c) => {
    let sum = 0; let n = 0
    for (let k = 0; k < 3; k += 1) { sum += px(x + dir * k, y, c); n += 1 }
    return sum / n
  })
  for (let x = x0; x <= x1; x += 1) {
    const top = rowAvg(x, y0 - 1, -1)
    const bottom = rowAvg(x, y1 + 1, 1)
    const wl = Math.exp(-(x - x0) / SIDE_TAPER)
    const wr = Math.exp(-(x1 - x) / SIDE_TAPER)
    for (let y = y0; y <= y1; y += 1) {
      const t = (y - y0) / (y1 - y0)
      const left = colAvg(x0 - 1, y, -1)
      const right = colAvg(x1 + 1, y, 1)
      const wv = Math.max(0, 1 - wl - wr)
      for (let c = 0; c < 3; c += 1) {
        const v = top[c] + (bottom[c] - top[c]) * t
        // Side columns fade into the fill (wave tips taper instead of being cut off).
        filled[(y * W + x) * C + c] = Math.round(v * wv + left[c] * wl * Math.exp(-(x - x0) / SIDE_TAPER) + right[c] * wr * Math.exp(-(x1 - x) / SIDE_TAPER) + v * (1 - wv) * 0.15)
      }
      mask[y * W + x] = 1
    }
  }
}

// Feather: blur the mask and blend original -> filled by it.
const maskImg = await sharp(Buffer.from(Uint8Array.from(mask, (v) => v * 255)), { raw: { width: W, height: H, channels: 1 } })
  .blur(FEATHER / 2).extractChannel(0).raw().toBuffer()
const out = Buffer.alloc(W * H * 3)
for (let i = 0; i < W * H; i += 1) {
  const m = maskImg[i] / 255
  for (let c = 0; c < 3; c += 1) out[i * 3 + c] = Math.round(data[i * C + c] * (1 - m) + filled[i * C + c] * m)
}

await sharp(out, { raw: { width: W, height: H, channels: 3 } })
  .resize(Math.round(W * OUT_SCALE), Math.round(H * OUT_SCALE), { kernel: 'lanczos3' })
  .sharpen({ sigma: 0.6 })
  .webp({ quality: 88, effort: 6 })
  .toFile(OUT)
const meta = await sharp(OUT).metadata()
console.log(OUT, meta.width, 'x', meta.height)
