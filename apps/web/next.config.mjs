/** The API origin the browser talks to (also allowed in the CSP). */
const API_ORIGIN = (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const WS_ORIGIN = API_ORIGIN.replace(/^http/, 'ws');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Shared workspace packages are consumed as TypeScript source, so let
  // Next transpile them rather than expecting prebuilt output.
  transpilePackages: ['@auxify/types', '@auxify/sdk'],
  // Security headers on every response. The CSP keeps 'unsafe-inline'/'eval'
  // for Next's dev runtime but still blocks remote script injection, framing,
  // plugin content, and form exfiltration.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self)' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "media-src 'self' data: blob:",
              `connect-src 'self' ${API_ORIGIN} ${WS_ORIGIN}`,
              "font-src 'self' data:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
  // The shared packages use NodeNext-style `.js` import specifiers in their
  // `.ts` source (e.g. `export * from './identity.js'`). `tsc` resolves these
  // under NodeNext, but Next's webpack uses Bundler resolution, so teach it the
  // same `.js` -> `.ts`/`.tsx` mapping. Without this, transpiling those packages
  // fails with "Can't resolve './identity.js'".
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
