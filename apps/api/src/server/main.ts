/**
 * API server entry point.
 *
 * Loads the environment, builds the composition root, and starts the HTTP
 * server hosting the versioned REST_API + SSE chat stream. Run with:
 *
 *   pnpm --filter @auxify/api dev      # tsx watch
 *   pnpm --filter @auxify/api start    # tsx (no watch)
 *
 * SECURITY NOTE: this dev server authenticates with a single local API
 * key/token (see `composition.ts`) and binds to loopback by default. It is for
 * LOCAL DEVELOPMENT. Do not expose it publicly without wiring the real
 * Auth_Service / API_Key_Manager and a production-grade rate limiter.
 */

import { buildComposition } from './composition';
import { loadConfig } from './env';
import { startHttpServer } from './http-server';
import { initDatabase } from './database';

async function main(): Promise<void> {
  const config = loadConfig();
  const database = await initDatabase();
  const composition = buildComposition(config, database);

  startHttpServer({
    restApi: composition.restApi,
    port: config.port,
    host: config.host,
    corsOrigin: config.corsOrigin,
    maxBodyBytes: config.maxBodyBytes,
    trustProxy: config.trustProxy,
    devApiKey: config.devApiKey,
    devToken: config.devToken,
    appAuth: config.appAuth,
    generateImage: composition.generateImage,
    extractFiles: composition.extractFiles,
    createVideo: composition.createVideo,
    getVideo: composition.getVideo,
    getVideoContent: composition.getVideoContent,
    createRealtimeSession: composition.createRealtimeSession,
    generateFile: composition.generateFile,
    deepResearch: composition.deepResearch,
    generateDocument: composition.generateDocument,
    renderDocument: composition.renderDocument,
    capabilities: {
      image: composition.imageEnabled,
      video: composition.videoEnabled,
      realtime: composition.realtimeEnabled,
      webSearch: composition.activeSearchProviders.length > 0,
      knowledge: composition.knowledgeEnabled,
    },
    realtimeConfig: config.azureRealtime,
  });

  const aiProviders = composition.activeAiProviders.join(', ') || 'none';
  const searchProviders =
    composition.activeSearchProviders.length > 0
      ? composition.activeSearchProviders.join(', ')
      : 'none (set SERPER_API_KEY / TAVILY_API_KEY / BRAVE_SEARCH_API_KEY to enable)';

  process.stdout.write(
    [
      '',
      '  Auxify API server',
      `  ➜ listening on   http://${config.host}:${config.port}`,
      `  ➜ health         http://${config.host}:${config.port}/health`,
      `  ➜ AI providers   ${aiProviders}`,
      `  ➜ search         ${searchProviders}`,
      `  ➜ image gen      ${composition.imageEnabled ? 'enabled' : 'disabled (set AZURE_OPENAI_DEPLOYMENT_IMAGE)'}`,
      `  ➜ video (sora)   ${composition.videoEnabled ? 'enabled' : 'disabled (set AZURE_OPENAI_DEPLOYMENT_VIDEO)'}`,
      `  ➜ realtime audio ${composition.realtimeEnabled ? 'enabled' : 'disabled (set AZURE_OPENAI_DEPLOYMENT_REALTIME)'}`,
      `  ➜ knowledge/RAG ${composition.knowledgeEnabled ? 'enabled (pgvector + embeddings)' : 'disabled (needs Postgres + pgvector + AZURE_OPENAI_DEPLOYMENT_EMBEDDING)'}`,
      `  ➜ serveable      ${composition.serveableModelIds.join(', ')}`,
      `  ➜ persistence    ${database !== null ? 'enabled (Postgres)' : 'disabled (set DATABASE_URL to enable)'}`,
      `  ➜ dev API key    ${config.devApiKey === 'dev-local-key' ? 'default (dev-local-key)' : 'custom (DEV_API_KEY is set; value not printed)'} — X-API-Key header`,
      '',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
