/**
 * Server environment + configuration loader (composition-root input).
 *
 * The platform's library code is credential-agnostic — every adapter takes its
 * connection facts as constructor input. This module is the one place that
 * reads the process environment (and a couple of local env files) and projects
 * it into a typed {@link ServerConfig} the composition root consumes. It never
 * logs secret VALUES — only which providers are configured.
 *
 * Credentials are supplied by the operator via environment variables (or the
 * git-ignored `.env` / `infra/aws/AWS.ENV` files); nothing is hardcoded.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the monorepo root, derived from this file's location. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Parse a minimal `KEY=VALUE` env file into `process.env` WITHOUT overwriting
 * a non-empty variable that is already set (process env wins over a file). Lines
 * that are blank or start with `#` are ignored; surrounding quotes are stripped.
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip an inline comment (whitespace + `#` to end of line) from an
      // unquoted value, e.g. `gpt-5.5   # PTU deployment` -> `gpt-5.5`.
      const hash = value.search(/\s+#/);
      if (hash !== -1) {
        value = value.slice(0, hash).trim();
      }
    }
    if (key.length > 0 && (process.env[key] === undefined || process.env[key] === '')) {
      process.env[key] = value;
    }
  }
}

/** Load the local env files the operator may have populated. */
export function loadLocalEnv(): void {
  loadEnvFile(resolve(REPO_ROOT, '.env'));
  loadEnvFile(resolve(REPO_ROOT, '.env.local'));
  // The AWS Bedrock API key lives here in this repo (git-ignored).
  loadEnvFile(resolve(REPO_ROOT, 'infra/aws/AWS.ENV'));
  // Azure OpenAI + Foundry credentials and web-search keys (git-ignored).
  loadEnvFile(resolve(REPO_ROOT, 'infra/azure/azure-credentials.env'));
}

/** AWS Bedrock connection facts (present only when a key is configured). */
export interface BedrockConfig {
  /** The Bedrock API key / bearer token (`AWS_BEARER_TOKEN_BEDROCK`). */
  token: string;
  /** The AWS region the Bedrock runtime is called in. */
  region: string;
}

/** Azure AI Foundry / Azure OpenAI connection facts. */
export interface AzureConfig {
  /** The resource endpoint, e.g. `https://my-resource.openai.azure.com`. */
  endpoint: string;
  /** The Azure API key. */
  apiKey: string;
  /** The Azure API version, e.g. `2024-10-21`. */
  apiVersion: string;
  /**
   * The API version used for reasoning / GPT-5-family deployments (which
   * require `max_completion_tokens` and a newer api-version than classic chat).
   */
  reasoningApiVersion: string;
}

/** Azure AI Foundry model-inference facts (partner / MaaS models). */
export interface FoundryConfig {
  /** The model-inference endpoint, usually ending in `/models`. */
  endpoint: string;
  /** The Azure AI Foundry API key. */
  apiKey: string;
  /** The model-inference API version. */
  apiVersion: string;
}

/** Azure image-generation account facts (may be a different resource/region). */
export interface AzureImageConfig {
  /** The endpoint of the resource hosting the image deployment. */
  endpoint: string;
  /** The API key for that resource. */
  apiKey: string;
  /** The image API version (often a preview version). */
  apiVersion: string;
  /** The image deployment name (e.g. `gpt-image-2`, `dall-e-3`). */
  deployment: string;
}

/** Azure Sora video-generation facts. */
export interface AzureVideoConfig {
  /** The endpoint of the resource hosting the Sora deployment. */
  endpoint: string;
  /** The API key for that resource. */
  apiKey: string;
  /** The Sora API version (e.g. `preview`). */
  apiVersion: string;
  /** The Sora deployment/model name (e.g. `sora-2`). */
  deployment: string;
}

/** Azure realtime (audio) session facts. */
export interface AzureRealtimeConfig {
  /** The endpoint of the resource hosting the realtime deployment. */
  endpoint: string;
  /** The API key for that resource. */
  apiKey: string;
  /** The realtime API version (e.g. `2025-04-01-preview`). */
  apiVersion: string;
  /** The realtime deployment name (e.g. `gpt-realtime`). */
  deployment: string;
}

/** Azure embeddings facts (for the RAG / knowledge layer). */
export interface AzureEmbeddingConfig {
  /** The endpoint hosting the embedding deployment. */
  endpoint: string;
  /** The API key for that resource. */
  apiKey: string;
  /** The embeddings API version. */
  apiVersion: string;
  /** The embedding deployment name (e.g. `text-embedding-3-large`). */
  deployment: string;
}

/** The fully-resolved server configuration the composition root consumes. */
export interface ServerConfig {
  /** TCP port the HTTP server listens on. */
  port: number;
  /** Host/interface to bind (defaults to loopback for safety). */
  host: string;
  /** Bedrock facts, or `null` when no Bedrock key is configured. */
  bedrock: BedrockConfig | null;
  /** Azure facts, or `null` when Azure is not configured. */
  azure: AzureConfig | null;
  /** Azure AI Foundry model-inference facts, or `null` when not configured. */
  foundry: FoundryConfig | null;
  /** Azure image-generation facts, or `null` when not configured. */
  azureImage: AzureImageConfig | null;
  /** Azure Sora video-generation facts, or `null` when not configured. */
  azureVideo: AzureVideoConfig | null;
  /** Azure realtime (audio) facts, or `null` when not configured. */
  azureRealtime: AzureRealtimeConfig | null;
  /** Azure embeddings facts (RAG/knowledge), or `null` when not configured. */
  azureEmbedding: AzureEmbeddingConfig | null;
  /**
   * The dev API key the bundled web app presents as `X-API-Key`. This is a
   * LOCAL-DEVELOPMENT credential only — see the security note in the server
   * entry point. Override with `DEV_API_KEY`.
   */
  devApiKey: string;
  /** The dev bearer token accepted on `Authorization: Bearer ...`. */
  devToken: string;
  /**
   * The single shared application login (Req: one super-admin credential for
   * all members). Validated server-side by `POST /v1/auth/login`; the password
   * is never shipped to the browser. Configure via `APP_AUTH_EMAIL` /
   * `APP_AUTH_PASSWORD`, and set `APP_AUTH_SECRET` to sign session tokens.
   */
  appAuth: { email: string; password: string; secret: string };
  /**
   * Allowed CORS origins for browser calls: a comma-separated list of exact
   * origins (default: the local web app), or `*` to allow any (NOT recommended
   * — with the well-known dev key it enables drive-by abuse from any website).
   */
  corsOrigin: string;
  /** Hard cap on request body size in bytes (oversized requests get a 413). */
  maxBodyBytes: number;
  /**
   * Trust the `X-Forwarded-For` header for client-IP resolution. Enable ONLY
   * when the API runs behind a trusted reverse proxy / load balancer;
   * otherwise clients can spoof their IP for rate limiting and audit.
   */
  trustProxy: boolean;
}

/** Read and project the environment into a {@link ServerConfig}. */
export function loadConfig(): ServerConfig {
  loadLocalEnv();

  const bedrockToken = process.env.AWS_BEARER_TOKEN_BEDROCK ?? '';
  const bedrock: BedrockConfig | null =
    bedrockToken.length > 0
      ? {
          token: bedrockToken,
          region:
            process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
        }
      : null;

  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT ?? '';
  const azureKey = process.env.AZURE_OPENAI_API_KEY ?? '';
  const azure: AzureConfig | null =
    azureEndpoint.length > 0 && azureKey.length > 0
      ? {
          endpoint: azureEndpoint,
          apiKey: azureKey,
          apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21',
          reasoningApiVersion:
            process.env.AZURE_OPENAI_REASONING_API_VERSION ?? '2024-12-01-preview',
        }
      : null;

  const foundryEndpoint =
    process.env.AZURE_FOUNDRY_INFERENCE_ENDPOINT ?? process.env.AZURE_FOUNDRY_ENDPOINT ?? '';
  const foundryKey = process.env.AZURE_FOUNDRY_API_KEY ?? '';
  const foundry: FoundryConfig | null =
    foundryEndpoint.length > 0 && foundryKey.length > 0
      ? {
          endpoint: foundryEndpoint,
          apiKey: foundryKey,
          apiVersion: process.env.AZURE_FOUNDRY_API_VERSION ?? '2024-05-01-preview',
        }
      : null;

  // Image generation may live on a separate Azure resource (e.g. eastus2).
  // Prefer the dedicated image account, falling back to the primary Azure one.
  const imageEndpoint =
    process.env.AZURE_OPENAI_EASTUS2_ENDPOINT ?? azureEndpoint;
  const imageKey = process.env.AZURE_OPENAI_EASTUS2_API_KEY ?? azureKey;
  const imageDeployment = process.env.AZURE_OPENAI_DEPLOYMENT_IMAGE ?? '';
  const azureImage: AzureImageConfig | null =
    imageEndpoint.length > 0 && imageKey.length > 0 && imageDeployment.length > 0
      ? {
          endpoint: imageEndpoint,
          apiKey: imageKey,
          apiVersion: process.env.AZURE_OPENAI_IMAGE_API_VERSION ?? '2025-04-01-preview',
          deployment: imageDeployment,
        }
      : null;

  // Sora video generation (typically the eastus2 account).
  const videoEndpoint = process.env.AZURE_OPENAI_EASTUS2_ENDPOINT ?? azureEndpoint;
  const videoKey = process.env.AZURE_OPENAI_EASTUS2_API_KEY ?? azureKey;
  const videoDeployment = process.env.AZURE_OPENAI_DEPLOYMENT_VIDEO ?? '';
  const azureVideo: AzureVideoConfig | null =
    videoEndpoint.length > 0 && videoKey.length > 0 && videoDeployment.length > 0
      ? {
          endpoint: videoEndpoint,
          apiKey: videoKey,
          apiVersion: process.env.AZURE_OPENAI_VIDEO_API_VERSION ?? 'preview',
          deployment: videoDeployment,
        }
      : null;

  // Realtime audio (typically the eastus2 account).
  const realtimeEndpoint = process.env.AZURE_OPENAI_EASTUS2_ENDPOINT ?? azureEndpoint;
  const realtimeKey = process.env.AZURE_OPENAI_EASTUS2_API_KEY ?? azureKey;
  const realtimeDeployment = process.env.AZURE_OPENAI_DEPLOYMENT_REALTIME ?? '';
  const azureRealtime: AzureRealtimeConfig | null =
    realtimeEndpoint.length > 0 && realtimeKey.length > 0 && realtimeDeployment.length > 0
      ? {
          endpoint: realtimeEndpoint,
          apiKey: realtimeKey,
          apiVersion: process.env.AZURE_OPENAI_REALTIME_API_VERSION ?? '2025-04-01-preview',
          deployment: realtimeDeployment,
        }
      : null;

  // Embeddings for the RAG / knowledge layer (primary Azure OpenAI account).
  const embeddingDeployment = process.env.AZURE_OPENAI_DEPLOYMENT_EMBEDDING ?? '';
  const azureEmbedding: AzureEmbeddingConfig | null =
    azureEndpoint.length > 0 && azureKey.length > 0 && embeddingDeployment.length > 0
      ? {
          endpoint: azureEndpoint,
          apiKey: azureKey,
          apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21',
          deployment: embeddingDeployment,
        }
      : null;

  const host = process.env.API_HOST ?? '127.0.0.1';
  const devApiKey = process.env.DEV_API_KEY ?? 'dev-local-key';
  const devToken = process.env.DEV_API_TOKEN ?? 'dev-local-token';

  // FAIL CLOSED: the well-known default dev credentials are only acceptable on
  // the loopback interface. Binding a public interface with them would let
  // anyone on the network drive the operator's AI accounts.
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback && (devApiKey === 'dev-local-key' || devToken === 'dev-local-token')) {
    throw new Error(
      `refusing to bind ${host} with default dev credentials; ` +
        'set DEV_API_KEY and DEV_API_TOKEN to strong values (or bind 127.0.0.1)',
    );
  }

  return {
    port: Number.parseInt(process.env.API_PORT ?? process.env.PORT ?? '8787', 10),
    host,
    bedrock,
    azure,
    foundry,
    azureImage,
    azureVideo,
    azureRealtime,
    azureEmbedding,
    devApiKey,
    devToken,
    appAuth: {
      email: (process.env.APP_AUTH_EMAIL ?? 'gaganchaudhary061506@gmail.com').trim().toLowerCase(),
      password: process.env.APP_AUTH_PASSWORD ?? '',
      secret: process.env.APP_AUTH_SECRET ?? process.env.DEV_API_TOKEN ?? 'dev-local-token',
    },
    corsOrigin:
      process.env.API_CORS_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000',
    maxBodyBytes: Number.parseInt(
      process.env.API_MAX_BODY_BYTES ?? String(32 * 1024 * 1024),
      10,
    ),
    trustProxy: process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1',
  };
}
