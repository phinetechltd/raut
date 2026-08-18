import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The Flutter client talks to /api/v1 from a device, so keep bodies generous
  // enough for base64 visit photos while still bounded.
  experimental: {
    serverActions: { bodySizeLimit: "8mb" },
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
