// The ChainLens monogram exactly as the navbar draws it (components/Navbar.tsx .nav-mark): /cl-mark.png — the
// logo trimmed to the mark's own edges — used as a mask and filled mint to white, so the geometry is the real
// logo and every placement matches the header. Decorative: pair it with the visible "ChainLens" text.
export default function BrandMark({ width = 40 }: { width?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'block',
        width,
        aspectRatio: '300 / 192',
        flexShrink: 0,
        background: 'linear-gradient(100deg, #1fd6dc 0%, #63ecec 42%, #ffffff 70%)',
        WebkitMask: "url('/cl-mark.png') center / contain no-repeat",
        mask: "url('/cl-mark.png') center / contain no-repeat",
      }}
    />
  )
}
