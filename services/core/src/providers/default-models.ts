/**
 * The default launch model catalog (Req 2.3).
 *
 * This is a *configuration* module, not code that special-cases any model: the
 * {@link defaultRegistryConfig} is a plain {@link RegistryConfig} object that
 * {@link ConfigModelRegistry.load} consumes. It enumerates, at launch (Req 2.3):
 *
 *   - all GPT-family chat models (Azure AI Foundry / OpenAI),
 *   - OpenAI reasoning models,
 *   - realtime models,
 *   - image-generation models, and
 *   - the Anthropic Claude Opus, Sonnet, and Haiku families (AWS Bedrock).
 *
 * Onboarding a further model — or an entirely new provider — is done by adding
 * an entry here (or supplying an alternative config/JSON file), never by
 * changing application source (Req 2.2). Each entry records the provider, the
 * provider-native identifier/deployment, modality, tier, max token limit,
 * vision/tool/reasoning capability flags, and per-1k input/output costs
 * (Req 2.6).
 *
 * NOTE ON COSTS/LIMITS: where exact public pricing or context limits are not
 * known with certainty they are PLACEHOLDERS. They are shape-correct (the right
 * fields, plausible magnitudes) so routing, budgeting, and listing logic can be
 * built and tested against them; operators override them via configuration
 * before production use (Req 2.2).
 */

import type { ModelConfig, ProviderConfig, RegistryConfig } from './types.js';

/** The two launch providers, each onboarded by configuration (Req 2.4, 2.5). */
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'azure',
    displayName: 'Azure AI Foundry (OpenAI)',
    kind: 'azure',
    apiVersion: '2024-10-21',
    settings: { note: 'GPT chat/reasoning/realtime/image models via Azure AI Foundry (Req 2.5)' },
  },
  {
    id: 'bedrock',
    displayName: 'AWS Bedrock (Anthropic)',
    kind: 'bedrock',
    region: 'us-east-1',
    settings: { note: 'Anthropic Claude Opus/Sonnet/Haiku via AWS Bedrock (Req 2.4)' },
  },
];

/**
 * GPT-family chat models served through Azure AI Foundry (Req 2.3, 2.5).
 * `providerModelId` is the Azure deployment name; costs/limits are placeholders.
 */
const GPT_CHAT_MODELS: ModelConfig[] = [
  {
    id: 'gpt-4o',
    provider: 'azure',
    providerModelId: 'gpt-4o',
    displayName: 'GPT-4o',
    modality: 'chat',
    tier: 'standard',
    maxTokens: 128_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.005, per1kOutputTokens: 0.015 },
  },
  {
    id: 'gpt-4o-mini',
    provider: 'azure',
    providerModelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    modality: 'chat',
    tier: 'economy',
    maxTokens: 128_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.00015, per1kOutputTokens: 0.0006 },
  },
  {
    id: 'gpt-4.1',
    provider: 'azure',
    providerModelId: 'gpt-4.1',
    displayName: 'GPT-4.1',
    modality: 'chat',
    tier: 'standard',
    maxTokens: 1_000_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.002, per1kOutputTokens: 0.008 },
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'azure',
    providerModelId: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini',
    modality: 'chat',
    tier: 'economy',
    maxTokens: 1_000_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.0004, per1kOutputTokens: 0.0016 },
  },
  {
    id: 'gpt-4-turbo',
    provider: 'azure',
    providerModelId: 'gpt-4-turbo',
    displayName: 'GPT-4 Turbo',
    modality: 'chat',
    tier: 'standard',
    maxTokens: 128_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.01, per1kOutputTokens: 0.03 },
  },
];

/** OpenAI reasoning models served through Azure AI Foundry (Req 2.3, 2.5). */
const OPENAI_REASONING_MODELS: ModelConfig[] = [
  {
    id: 'o3',
    provider: 'azure',
    providerModelId: 'o3',
    displayName: 'OpenAI o3',
    modality: 'reasoning',
    tier: 'premium',
    maxTokens: 200_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: true,
    cost: { per1kInputTokens: 0.01, per1kOutputTokens: 0.04 },
  },
  {
    id: 'o4-mini',
    provider: 'azure',
    providerModelId: 'o4-mini',
    displayName: 'OpenAI o4-mini',
    modality: 'reasoning',
    tier: 'standard',
    maxTokens: 200_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: true,
    cost: { per1kInputTokens: 0.0011, per1kOutputTokens: 0.0044 },
  },
];

/** Low-latency realtime models served through Azure AI Foundry (Req 2.3, 2.5). */
const REALTIME_MODELS: ModelConfig[] = [
  {
    id: 'gpt-4o-realtime',
    provider: 'azure',
    providerModelId: 'gpt-4o-realtime-preview',
    displayName: 'GPT-4o Realtime',
    modality: 'realtime',
    tier: 'standard',
    maxTokens: 128_000,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.005, per1kOutputTokens: 0.02 },
  },
  {
    id: 'gpt-4o-mini-realtime',
    provider: 'azure',
    providerModelId: 'gpt-4o-mini-realtime-preview',
    displayName: 'GPT-4o mini Realtime',
    modality: 'realtime',
    tier: 'economy',
    maxTokens: 128_000,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.0006, per1kOutputTokens: 0.0024 },
  },
];

/**
 * Image-generation models served through Azure AI Foundry (Req 2.3, 2.5, 2.9).
 * Image models price per generated image, not per token; the per-1k token cost
 * fields are 0 and the per-image price lives in placeholder settings-free form
 * here (a dedicated image-pricing field can be added by configuration later).
 */
const IMAGE_MODELS: ModelConfig[] = [
  {
    id: 'gpt-image-1',
    provider: 'azure',
    providerModelId: 'gpt-image-1',
    displayName: 'GPT Image 1',
    modality: 'image',
    tier: 'standard',
    maxTokens: 4_000,
    supportsVision: true,
    supportsTools: false,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0, per1kOutputTokens: 0 },
  },
  {
    id: 'dall-e-3',
    provider: 'azure',
    providerModelId: 'dall-e-3',
    displayName: 'DALL·E 3',
    modality: 'image',
    tier: 'standard',
    maxTokens: 4_000,
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0, per1kOutputTokens: 0 },
  },
];

/** Anthropic Claude Opus/Sonnet/Haiku families served through AWS Bedrock (Req 2.3, 2.4). */
const CLAUDE_MODELS: ModelConfig[] = [
  {
    id: 'claude-opus-4',
    provider: 'bedrock',
    providerModelId: 'anthropic.claude-opus-4-20250514-v1:0',
    displayName: 'Claude Opus 4',
    modality: 'chat',
    tier: 'premium',
    maxTokens: 200_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: true,
    cost: { per1kInputTokens: 0.015, per1kOutputTokens: 0.075 },
  },
  {
    id: 'claude-sonnet-4',
    provider: 'bedrock',
    providerModelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
    displayName: 'Claude Sonnet 4',
    modality: 'chat',
    tier: 'standard',
    maxTokens: 200_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: true,
    cost: { per1kInputTokens: 0.003, per1kOutputTokens: 0.015 },
  },
  {
    id: 'claude-3-5-sonnet',
    provider: 'bedrock',
    providerModelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    displayName: 'Claude 3.5 Sonnet',
    modality: 'chat',
    tier: 'standard',
    maxTokens: 200_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.003, per1kOutputTokens: 0.015 },
  },
  {
    id: 'claude-3-5-haiku',
    provider: 'bedrock',
    providerModelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
    displayName: 'Claude 3.5 Haiku',
    modality: 'chat',
    tier: 'economy',
    maxTokens: 200_000,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.0008, per1kOutputTokens: 0.004 },
  },
  {
    id: 'claude-3-haiku',
    provider: 'bedrock',
    providerModelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    displayName: 'Claude 3 Haiku',
    modality: 'chat',
    tier: 'economy',
    maxTokens: 200_000,
    supportsVision: true,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.00025, per1kOutputTokens: 0.00125 },
  },
];

/**
 * An embedding model for the RAG/knowledge pipeline (Req 2.1, 44.2). Produces
 * the platform-standard 1536-dimension vectors.
 */
const EMBEDDING_MODELS: ModelConfig[] = [
  {
    id: 'text-embedding-3-small',
    provider: 'azure',
    providerModelId: 'text-embedding-3-small',
    displayName: 'Text Embedding 3 Small',
    modality: 'embedding',
    tier: 'economy',
    maxTokens: 8_191,
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.00002, per1kOutputTokens: 0 },
  },
];

/**
 * The complete default launch catalog (Req 2.3): GPT chat + OpenAI reasoning +
 * realtime + image-generation + Claude Opus/Sonnet/Haiku + an embedding model.
 */
export const DEFAULT_MODELS: ModelConfig[] = [
  ...GPT_CHAT_MODELS,
  ...OPENAI_REASONING_MODELS,
  ...REALTIME_MODELS,
  ...IMAGE_MODELS,
  ...CLAUDE_MODELS,
  ...EMBEDDING_MODELS,
];

/**
 * The default {@link RegistryConfig} a {@link ConfigModelRegistry} loads at
 * launch (Req 2.3). Operators may replace or extend it purely by configuration
 * (Req 2.2).
 */
export const defaultRegistryConfig: RegistryConfig = {
  providers: DEFAULT_PROVIDERS,
  models: DEFAULT_MODELS,
};
