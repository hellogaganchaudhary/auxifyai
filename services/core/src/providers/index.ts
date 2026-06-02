/**
 * Provider_Abstraction_Layer (Req 2).
 *
 * The single, configuration-driven boundary through which all AI model traffic
 * flows. Onboarding a provider or model is a configuration change, never a code
 * change (Req 2.2).
 *
 * Surface:
 *   - {@link AIProvider} — the unified provider interface (chat/embed/
 *     generateImage/realtime/listModels/healthCheck) every adapter implements
 *     (Req 2.1). The request/response payloads it uses ({@link ChatRequest},
 *     {@link ChatChunk}, {@link EmbedRequest}, {@link ImageRequest},
 *     {@link RealtimeSession}, {@link HealthStatus}) are shared types from
 *     `@auxify/types`, reused by the Client_SDK and web client (Req 46.8).
 *   - {@link ModelRegistry} / {@link ConfigModelRegistry} — the config-driven
 *     catalog exposing each model's modality, tier, costs, and capability flags
 *     (Req 2.6, 2.7), with `markAvailable`/`markUnavailable` for health gating
 *     (Req 2.10, task 5.4).
 *   - {@link RegistryConfig} / {@link ModelConfig} / {@link ProviderConfig} —
 *     the configuration shapes that onboard models and providers (Req 2.2).
 *   - {@link defaultRegistryConfig} / {@link DEFAULT_MODELS} /
 *     {@link DEFAULT_PROVIDERS} — the launch catalog: GPT chat, OpenAI
 *     reasoning, realtime, image-generation, and Claude Opus/Sonnet/Haiku
 *     families (Req 2.3).
 *   - {@link StubProvider} — a spec-faithful, in-memory reference provider for
 *     conformance tests.
 *   - {@link BedrockProvider} / {@link AzureProvider} — the concrete vendor
 *     adapters: Anthropic Claude via AWS Bedrock (Req 2.4) and OpenAI GPT/
 *     reasoning/realtime/image via Azure AI Foundry (Req 2.5). Each talks to its
 *     vendor through a narrow, injectable transport port
 *     ({@link BedrockClientPort} / {@link AzureClientPort}) so request shaping
 *     and response mapping are fully unit-testable without the vendor SDK.
 *   - {@link assertChatCapability} / {@link assertImageGenerationCapability} /
 *     {@link requestHasImageInput} — the vision (Req 2.8) and image-generation
 *     (Req 2.9) capability gates.
 *   - {@link ModelNotFoundError} / {@link InvalidRegistryConfigError} /
 *     {@link UnsupportedModelCapabilityError} — the typed errors.
 */

export {
  ModelNotFoundError,
  InvalidRegistryConfigError,
  UnsupportedModelCapabilityError,
  type AIProvider,
  type ModelRegistry,
  type RegistryConfig,
  type ModelConfig,
  type ProviderConfig,
} from './types.js';

export { ConfigModelRegistry } from './model-registry.js';

export { defaultRegistryConfig, DEFAULT_MODELS, DEFAULT_PROVIDERS } from './default-models.js';

export {
  assertChatCapability,
  assertImageGenerationCapability,
  requestHasImageInput,
} from './capabilities.js';

export { StubProvider, type StubProviderOptions } from './stub-provider.js';

export {
  BedrockProvider,
  type BedrockProviderOptions,
  type BedrockClientPort,
  type BedrockInvokeModelInput,
  type BedrockInvokeModelResult,
  type BedrockStreamEvent,
} from './bedrock-provider.js';

export {
  AzureProvider,
  type AzureProviderOptions,
  type AzureClientPort,
  type AzureRequestInput,
  type AzureResponseResult,
  type AzureStreamEvent,
} from './azure-provider.js';

export {
  ProviderHealthChecker,
  type ProviderHealthCheckerOptions,
  type ProviderHealthCheckResult,
  type SchedulerLike,
} from './health-checker.js';
