import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: true,
  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [390, 414, 768, 1080, 1280, 1920],
    imageSizes: [24, 32, 40, 48, 64, 96, 128],
  },
};

export default nextConfig;
