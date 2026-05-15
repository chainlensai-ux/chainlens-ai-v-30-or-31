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
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
      {
        src: '/cl-logo.png',
        sizes: '408x612',
        type: 'image/png',
      },
    ],
  }
}
