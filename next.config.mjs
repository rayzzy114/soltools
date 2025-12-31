import "dotenv/config"

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
  env: {
    NEXT_PUBLIC_SOLANA_NETWORK: process.env.NEXT_PUBLIC_SOLANA_NETWORK,
    RPC: process.env.RPC,
  },
  // SaaS hardening: don't ship browser source maps in prod
  productionBrowserSourceMaps: false,
}

export default nextConfig
