import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: true,
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
