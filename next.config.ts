import type { NextConfig } from "next";

const securityHeaders = [
  { key: 'X-Frame-Options',        value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-XSS-Protection',       value: '1; mode=block' },
  { key: 'Referrer-Policy',        value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy',     value: 'camera=(), microphone=(), geolocation=()' },
]

const nextConfig: NextConfig = {
  compress: true,
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    // Mobile-first breakpoints: 390/414 cover iPhone, 768 covers tablet
    deviceSizes: [390, 414, 768, 1080, 1280, 1920],
    imageSizes: [24, 32, 40, 48, 64, 96, 128],
    // Cache optimised images for 1 year — reduces repeat-visit LCP
    minimumCacheTTL: 31536000,
  },
  // Remove console.log calls from production bundles to reduce TBT
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },
};

export default nextConfig;
