import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ChainLens AI',
    short_name: 'ChainLens',
    description: 'Base onchain intelligence terminal — scan tokens, track whales, ask Clark AI.',
    start_url: '/',
    display: 'standalone',
    background_color: '#050816',
    theme_color: '#050816',
    icons: [
      { src: '/favicon-32.png', sizes: '32x32',   type: 'image/png' },
      { src: '/apple-icon.png', sizes: '180x180',  type: 'image/png' },
      { src: '/icon.png',       sizes: '512x512',  type: 'image/png' },
    ],
  }
}
