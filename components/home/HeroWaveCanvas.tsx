'use client'

// Animates the homepage hero's existing wave image (public/home/hero-bg.webp) in place.
//
// The background is a flat raster image, so there are no individual lines to move and moving it with
// CSS transforms would only shift the picture. This canvas redraws that same image every frame
// through a small WebGL shader, so everything on screen is still the image's own pixels:
//
//  1. Flow: a layered, liquid displacement bends the image inside the three wave regions (left,
//     right, bottom) only. Outside them the displacement is zero, so the black centre, colours,
//     density and composition are untouched and each wave stays anchored where it is.
//  2. Data pulses: a few soft spots travel along paths fitted to the image's own crest lines
//     (measured from hero-bg.webp). A spot brightens only the thin strands it passes over (a local
//     contrast test), tinted with the existing mint, so it reads as a pulse running along the lines;
//     no new lines are drawn and the dark areas are never lit.
//  3. Cursor (mouse/trackpad only): lines near the pointer are dragged a little in the direction the
//     pointer moves and spring back when it stops or leaves. Also confined to the wave regions.
//
// Every time-based term uses an integer multiple of the loop phase, so the loop is seamless. At rest
// (amplitude 0) the canvas matches the CSS background it sits on, and it is only created when motion
// is allowed and WebGL works; otherwise the static CSS background is what shows. Rendering stops when
// the hero is scrolled away or the tab is hidden.
//
// The image is first drawn with the same cover fit as the CSS background into a canvas at device
// resolution, so the shader samples it ~1:1 instead of minifying the 2508px source on the GPU.
import { useEffect, useRef } from 'react'

const SRC = '/home/hero-bg.webp'
// One full loop. Every time-based term in the shader uses an integer multiple of the phase.
const PERIOD_MS = 16000
// Flow displacement as a fraction of the drawn image width (~16px at 1440px wide).
const AMPLITUDE = 0.011
// Cursor drag: peak displacement and radius as fractions of the drawn image width.
const CURSOR_AMPLITUDE = 0.012
const CURSOR_RADIUS = 0.085
// Ease the motion in after load so the canvas takes over from the static image without a jump.
const RAMP_MS = 1400
const MAX_DPR = 2

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform vec2 uRes;      // canvas size, device px
uniform vec2 uImgOff;   // top-left of the drawn image, device px (y down)
uniform vec2 uImgSize;  // drawn image size, device px
uniform float uPhase;   // 0..2pi over one loop
uniform float uAmp;     // flow displacement, device px
uniform float uPulse;   // 0..1 strength of the travelling highlights
uniform vec2 uMouse;    // pointer, device px (y down)
uniform vec2 uMouseVel; // smoothed pointer velocity, device px per frame-ish (already scaled)
uniform float uMouseAmp;// 0..1 cursor influence
uniform float uMouseR;  // cursor radius, device px

const float TAU = 6.2831853;
const vec3 MINT = vec3(0.122, 0.839, 0.863); // #1fd6dc, the page's existing accent

// 1 inside an elliptical wave region, easing to 0 at its rim.
float region(vec2 uv, vec2 c, vec2 r) {
  return 1.0 - smoothstep(0.45, 1.0, length((uv - c) / r));
}

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 sampleAt(vec2 q) { return texture2D(uTex, vec2(q.x / uRes.x, 1.0 - q.y / uRes.y)).rgb; }

// A soft elongated spot at path point (px, py), travelling along slope dy/dx = k.
float spot(vec2 uv, float px, float py, float k, float fade) {
  vec2 t = normalize(vec2(1.0, k));
  vec2 n = vec2(-t.y, t.x);
  vec2 d = uv - vec2(px, py);
  float a = dot(d, t) / 0.045;   // along the line
  float b = dot(d, n) / 0.030;   // across the bundle
  return fade * exp(-(a * a + b * b));
}

// Pulse position 0..1 along its path; visible for the first 60% of its cycle with soft ends.
float pulseFade(float s) { return smoothstep(0.0, 0.12, s) * (1.0 - smoothstep(0.45, 0.6, s)); }

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = (p - uImgOff) / uImgSize;
  float x = uv.x;
  float y = uv.y;
  float ph = uPhase;

  // ---- 1. Flow: layered travelling swells, each region with its own direction and rhythm ----
  float wl = region(uv, vec2(0.19, 0.50), vec2(0.40, 0.48));
  float lY = sin(TAU * x / 0.30 - ph + y * 3.0)
           + 0.45 * sin(TAU * x / 0.14 - 2.0 * ph + 1.3 + 2.0 * sin(TAU * y / 0.5 + ph))
           + 0.25 * sin(TAU * (x + y) / 0.09 - 3.0 * ph);
  float lX = sin(TAU * y / 0.32 - ph + 0.8) + 0.35 * sin(TAU * y / 0.15 - 2.0 * ph);

  float wr = region(uv, vec2(0.83, 0.32), vec2(0.36, 0.40));
  float rY = sin(TAU * x / 0.24 + ph + y * 2.0)
           + 0.40 * sin(TAU * x / 0.12 + 2.0 * ph + 0.7 + 1.6 * sin(TAU * y / 0.4 - ph))
           + 0.22 * sin(TAU * (x - y) / 0.08 + 3.0 * ph);
  float rX = sin(TAU * y / 0.36 + ph + 2.0) + 0.30 * sin(TAU * y / 0.16 + 2.0 * ph);

  float wb = region(uv, vec2(0.58, 0.88), vec2(0.48, 0.30));
  float bY = sin(TAU * x / 0.30 - ph)
           + 0.40 * sin(TAU * x / 0.14 - 2.0 * ph + 2.1 + 1.4 * sin(TAU * x / 0.6 + ph))
           + 0.22 * sin(TAU * x / 0.07 - 3.0 * ph);
  float bX = sin(TAU * x / 0.42 - ph + 0.5);

  float waves = clamp(wl + wr + wb, 0.0, 1.0);
  vec2 d = vec2(
    wl * lX * 0.35 + wr * rX * 0.30 + wb * bX * 0.40,
    wl * lY * 0.80 + wr * rY * 0.70 + wb * bY * 0.65
  ) * uAmp;

  // ---- 3. Cursor: drag nearby lines along the pointer's motion plus a slight bulge ----
  if (uMouseAmp > 0.001) {
    vec2 m = p - uMouse;
    float g = exp(-dot(m, m) / (uMouseR * uMouseR));
    vec2 radial = length(m) > 0.5 ? normalize(m) : vec2(0.0);
    d += (uMouseVel + radial * uMouseR * 0.06) * g * uMouseAmp * waves;
  }

  // No displacement at the image edges, so nothing is sampled from outside it.
  float edge = smoothstep(0.0, 0.04, x) * smoothstep(0.0, 0.04, 1.0 - x)
             * smoothstep(0.0, 0.04, y) * smoothstep(0.0, 0.04, 1.0 - y);
  vec2 src = p - d * edge;
  vec3 col = sampleAt(src);

  // ---- 2. Data pulses along the image's own crest lines (paths measured from hero-bg.webp) ----
  if (uPulse > 0.001) {
    // Evaluate at the displaced source point, so a pulse rides the moving lines.
    vec2 su = (src - uImgOff) / uImgSize;
    float f = ph / TAU;
    float s1 = fract(f * 2.0);         // left mint crest, flowing toward the centre
    float s2 = fract(f * 2.0 + 0.5);   // left grey strands
    float s3 = fract(f * 2.0 + 0.25);  // top-right mint crest, flowing toward the centre
    float s4 = fract(f * 2.0 + 0.75);  // bottom mint crest
    float x1 = mix(-0.02, 0.30, s1 / 0.6);
    float x2 = mix(0.00, 0.31, s2 / 0.6);
    float x3 = mix(1.01, 0.68, s3 / 0.6);
    float x4 = mix(0.46, 0.76, s4 / 0.6);
    float sp =
        spot(su, x1, 0.624 + 0.05 * x1 + 1.2 * x1 * x1, 0.05 + 2.4 * x1, pulseFade(s1))
      + spot(su, x2, 0.125 + 1.25 * x2 - 0.95 * x2 * x2, 1.25 - 1.9 * x2, pulseFade(s2) * 0.8)
      + spot(su, x3, 0.311 + 1.4 * (x3 - 0.80) * (x3 - 0.80), 2.8 * (x3 - 0.80), pulseFade(s3))
      + spot(su, x4, 0.886, 0.0, pulseFade(s4));
    if (sp > 0.002) {
      // Thin-strand mask: brighter than its surroundings (local contrast), so broad glows and the
      // black background are never lit, only the lines themselves.
      float o = 2.5;
      float around = 0.25 * (lum(sampleAt(src + vec2(o, 0.0))) + lum(sampleAt(src - vec2(o, 0.0)))
                           + lum(sampleAt(src + vec2(0.0, o))) + lum(sampleAt(src - vec2(0.0, o))));
      float strand = smoothstep(0.004, 0.05, lum(col) - around) + 0.35 * smoothstep(0.10, 0.45, lum(col));
      float h = clamp(sp * uPulse, 0.0, 1.0) * clamp(strand, 0.0, 1.0);
      col += h * (MINT * 0.55 + col * 0.6);
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
`

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

// "50% 0%" style computed background-position -> fractions. Falls back to centre/top.
function parsePosition(value: string): [number, number] {
  const parts = value.split(/\s+/).map((v) => (v.endsWith('%') ? parseFloat(v) / 100 : NaN))
  return [Number.isFinite(parts[0]) ? parts[0] : 0.5, Number.isFinite(parts[1]) ? parts[1] : 0]
}

export default function HeroWaveCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    if (!canvas || !host) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' })
    if (!gl) return

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    const program = gl.createProgram()
    if (!vs || !fs || !program) return
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const u = {
      res: gl.getUniformLocation(program, 'uRes'),
      off: gl.getUniformLocation(program, 'uImgOff'),
      size: gl.getUniformLocation(program, 'uImgSize'),
      phase: gl.getUniformLocation(program, 'uPhase'),
      amp: gl.getUniformLocation(program, 'uAmp'),
      pulse: gl.getUniformLocation(program, 'uPulse'),
      mouse: gl.getUniformLocation(program, 'uMouse'),
      mouseVel: gl.getUniformLocation(program, 'uMouseVel'),
      mouseAmp: gl.getUniformLocation(program, 'uMouseAmp'),
      mouseR: gl.getUniformLocation(program, 'uMouseR'),
    }

    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const image = new Image()
    const scratch = document.createElement('canvas')
    let disposed = false
    let ready = false
    let visible = true
    let raf = 0
    let start = 0
    let drawWidth = 0
    let dpr = 1

    // Cursor state (device px, canvas space). `target*` comes from pointer events; the shader gets a
    // smoothed position, a decaying velocity (the drag) and an eased influence, so lines move
    // smoothly and settle back on their own when the pointer stops or leaves.
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
    let pointerInside = false
    let targetX = 0
    let targetY = 0
    let mouseX = 0
    let mouseY = 0
    let velX = 0
    let velY = 0
    let influence = 0
    let lastFrame = 0

    // Draw the image into a device-resolution canvas with the same cover fit as the CSS
    // background, then upload it as the texture.
    const layout = () => {
      const rect = host.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const w = Math.max(1, Math.round(rect.width * dpr))
      const h = Math.max(1, Math.round(rect.height * dpr))
      const [px, py] = parsePosition(getComputedStyle(host).backgroundPosition)
      const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight)
      const iw = image.naturalWidth * scale
      const ih = image.naturalHeight * scale
      const ox = (w - iw) * px
      const oy = (h - ih) * py

      canvas.width = w
      canvas.height = h
      scratch.width = w
      scratch.height = h
      const ctx = scratch.getContext('2d')
      if (!ctx) return false
      ctx.fillStyle = '#020303'
      ctx.fillRect(0, 0, w, h)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(image, ox, oy, iw, ih)

      gl.viewport(0, 0, w, h)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scratch)
      gl.uniform2f(u.res, w, h)
      gl.uniform2f(u.off, ox, oy)
      gl.uniform2f(u.size, iw, ih)
      gl.uniform1f(u.mouseR, iw * CURSOR_RADIUS)
      drawWidth = iw
      return true
    }

    const frame = (now: number) => {
      raf = 0
      if (disposed || !ready || !visible || document.hidden) return
      if (!start) start = now
      const t = now - start
      // Frame-rate independent smoothing (dt in 60fps frames), so 120Hz screens feel the same.
      const dt = lastFrame ? Math.min(4, (now - lastFrame) / 16.67) : 1
      lastFrame = now
      const ramp = Math.min(1, t / RAMP_MS)
      const eased = ramp * ramp * (3 - 2 * ramp)
      gl.uniform1f(u.phase, ((t % PERIOD_MS) / PERIOD_MS) * Math.PI * 2)
      gl.uniform1f(u.amp, drawWidth * AMPLITUDE * eased)
      gl.uniform1f(u.pulse, eased)

      // Cursor: follow the pointer with a little lag, let the drag velocity decay, and ease the
      // influence in/out so lines return to their paths smoothly.
      const follow = 1 - Math.pow(1 - 0.18, dt)
      const prevX = mouseX
      const prevY = mouseY
      mouseX += (targetX - mouseX) * follow
      mouseY += (targetY - mouseY) * follow
      const maxDrag = drawWidth * CURSOR_AMPLITUDE
      const decay = Math.pow(0.9, dt)
      velX = velX * decay + (mouseX - prevX) * 0.9
      velY = velY * decay + (mouseY - prevY) * 0.9
      const speed = Math.hypot(velX, velY)
      if (speed > maxDrag) { velX *= maxDrag / speed; velY *= maxDrag / speed }
      influence += ((pointerInside ? 1 : 0) - influence) * (1 - Math.pow(1 - 0.06, dt))
      gl.uniform2f(u.mouse, mouseX, mouseY)
      gl.uniform2f(u.mouseVel, velX, velY)
      gl.uniform1f(u.mouseAmp, influence * eased)

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      raf = requestAnimationFrame(frame)
    }
    const kick = () => {
      if (!raf && ready && visible && !document.hidden) raf = requestAnimationFrame(frame)
    }

    let resizeQueued = 0
    const ro = new ResizeObserver(() => {
      if (!ready || resizeQueued) return
      resizeQueued = requestAnimationFrame(() => {
        resizeQueued = 0
        if (!disposed && layout()) kick()
      })
    })
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      kick()
    })
    const onVisibility = () => { lastFrame = 0; kick() }
    // Mouse/trackpad only: touch and pen never distort the lines.
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || !finePointer.matches) return
      const rect = host.getBoundingClientRect()
      const x = (e.clientX - rect.left) * dpr
      const y = (e.clientY - rect.top) * dpr
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom
      if (inside && !pointerInside && influence < 0.01) { mouseX = x; mouseY = y; velX = 0; velY = 0 }
      pointerInside = inside
      targetX = x
      targetY = y
    }
    const onPointerLeave = () => { pointerInside = false }
    const onLost = (e: Event) => {
      e.preventDefault()
      ready = false
      canvas.style.opacity = '0'
    }

    image.decoding = 'async'
    image.src = SRC
    image.decode().then(() => {
      if (disposed || !layout()) return
      ready = true
      // First frame is drawn with zero amplitude, i.e. identical to the static background.
      gl.uniform1f(u.phase, 0)
      gl.uniform1f(u.amp, 0)
      gl.uniform1f(u.pulse, 0)
      gl.uniform1f(u.mouseAmp, 0)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      canvas.style.opacity = '1'
      kick()
    }).catch(() => {})

    ro.observe(host)
    io.observe(host)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('webglcontextlost', onLost)

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      if (resizeQueued) cancelAnimationFrame(resizeQueued)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointermove', onPointerMove)
      document.documentElement.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('webglcontextlost', onLost)
      gl.deleteTexture(texture)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
    }
  }, [])

  return <canvas ref={canvasRef} className="ref-wave-canvas" aria-hidden="true" />
}
