/**
 * Web client runtime configuration.
 *
 * The web app talks to the Auxify API over HTTP. The API origin and the dev
 * credential are read from public env vars (baked at build time by Next), with
 * sensible local-dev defaults so the app works out of the box against the local
 * API server.
 *
 * SECURITY NOTE: `NEXT_PUBLIC_*` values are shipped to the browser. The dev API
 * key here is a LOCAL-DEVELOPMENT credential matching the dev API server. In
 * production, authentication is per-user (a real sign-in issuing a bearer
 * token), and no shared key is embedded in the client bundle.
 */

/** The API origin the SDK prefixes onto `/v1/...` paths. */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8787';

/** The local-dev API key presented as `X-API-Key`. */
export const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? 'dev-local-key';
