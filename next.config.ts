import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  serverExternalPackages: ['ffmpeg-static'],
  outputFileTracingIncludes: {
    '/api/spike/frames': ['./node_modules/ffmpeg-static/ffmpeg'],
    '/api/generate': ['./node_modules/ffmpeg-static/ffmpeg'],
  },
};

export default nextConfig;
