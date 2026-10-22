'use client'

// Animates the homepage hero's existing wave image (public/home/hero-bg.webp) in place.
//
// The background is a flat image, so moving it with CSS transforms only shifts the picture. This
// canvas redraws that same image every frame through a small WebGL shader that bends it with a
// smooth travelling ripple confined to the three wave groups (left, right, bottom). Away from the
// waves the displacement is zero, so the black background, colours, text area and composition are
// untouched; at rest (amplitude 0) the canvas matches the CSS background it sits on.
//
// The image is first drawn with the same cover fit as the CSS background into a canvas at device
// resolution, so the shader samples it ~1:1 instead of minifying the 2508px source on the GPU.
// The canvas is only created when motion is allowed and WebGL works; otherwise the static CSS
// background is what shows.
import { useEffect, useRef } from 'react'

const SRC = '/home/hero-bg.webp'
// One full cycle. Every term in the shader uses the phase or twice the phase, so the loop is seamless.
const PERIOD_MS = 12000
// Ripple height as a fraction of the drawn image width (~7px at 1440px wide).
const AMPLITUDE = 0.005
// Ease the ripple in after load so the canvas takes over from the static image without a jump.
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
uniform float uPhase;   // 0..2pi over one period
uniform float uAmp;     // ripple height, device px

const float TAU = 6.2831853;

// 1 inside an elliptical wave region, easing to 0 at its rim.
float region(vec2 uv, vec2 c, vec2 r) {
  return 1.0 - smoothstep(0.45, 1.0, length((uv - c) / r));
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = (p - uImgOff) / uImgSize;
  float x = uv.x;
  float y = uv.y;
  float ph = uPhase;

  // Left wave: crests travel right, toward the centre.
  float wl = region(uv, vec2(0.19, 0.50), vec2(0.40, 0.48));
  float lY = sin(TAU * x / 0.24 - ph + y * 3.0) + 0.35 * sin(TAU * x / 0.12 - 2.0 * ph + 1.3);
  float lX = sin(TAU * y / 0.30 - ph + 0.8);

  // Right wave: slower, longer swell travelling left.
  float wr = region(uv, vec2(0.83, 0.32), vec2(0.36, 0.40));
  float rY = sin(TAU * x / 0.20 + ph + y * 2.0) + 0.30 * sin(TAU * x / 0.11 + 2.0 * ph + 0.7);
  float rX = sin(TAU * y / 0.35 + ph + 2.0);

  // Bottom wave: horizontal ripple.
  float wb = region(uv, vec2(0.58, 0.88), vec2(0.48, 0.30));
  float bY = sin(TAU * x / 0.26 - ph) + 0.30 * sin(TAU * x / 0.13 - 2.0 * ph + 2.1);
  float bX = sin(TAU * x / 0.40 - ph + 0.5);

  vec2 d = vec2(
    wl * lX * 0.35 + wr * rX * 0.30 + wb * bX * 0.45,
    wl * lY + wr * rY * 0.85 + wb * bY * 0.80
  ) * uAmp;

  // No displacement at the image edges, so nothing is sampled from outside it.
  float edge = smoothstep(0.0, 0.04, x) * smoothstep(0.0, 0.04, 1.0 - x)
             * smoothstep(0.0, 0.04, y) * smoothstep(0.0, 0.04, 1.0 - y);
  vec2 src = p - d * edge;

  gl_FragColor = texture2D(uTex, vec2(src.x / uRes.x, 1.0 - src.y / uRes.y));
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

    // Draw the image into a device-resolution canvas with the same cover fit as the CSS
    // background, then upload it as the texture.
    const layout = () => {
      const rect = host.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
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
      drawWidth = iw
      return true
    }

    const frame = (now: number) => {
      raf = 0
      if (disposed || !ready || !visible || document.hidden) return
      if (!start) start = now
      const t = now - start
      const ramp = Math.min(1, t / RAMP_MS)
      const eased = ramp * ramp * (3 - 2 * ramp)
      gl.uniform1f(u.phase, ((t % PERIOD_MS) / PERIOD_MS) * Math.PI * 2)
      gl.uniform1f(u.amp, drawWidth * AMPLITUDE * eased)
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
    const onVisibility = () => kick()
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
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      canvas.style.opacity = '1'
      kick()
    }).catch(() => {})

    ro.observe(host)
    io.observe(host)
    document.addEventListener('visibilitychange', onVisibility)
    canvas.addEventListener('webglcontextlost', onLost)

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      if (resizeQueued) cancelAnimationFrame(resizeQueued)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
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
