/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Shared workspace packages are consumed as TypeScript source, so let
  // Next transpile them rather than expecting prebuilt output.
  transpilePackages: ['@auxify/types', '@auxify/sdk'],
};

export default nextConfig;
