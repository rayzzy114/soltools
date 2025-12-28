/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    turbopack: true,
  },
  // SaaS hardening: don't ship browser source maps in prod
  productionBrowserSourceMaps: false,
}

export default nextConfig
