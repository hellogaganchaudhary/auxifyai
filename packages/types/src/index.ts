/**
 * @auxify/types — shared TypeScript domain types reused across the backend
 * services, the SDK, and the web client (Requirement 46.8: a single source of
 * shared type definitions).
 *
 * This package is the canonical home for cross-cutting domain types:
 *   - identity & tenancy — {@link Principal}, {@link TenantContext},
 *     {@link Role}, {@link ResourceRef}, {@link Action} (see `./identity`)
 *   - model registry — {@link ModelInfo}, {@link ModelTier},
 *     {@link ModelModality} (see `./models`)
 *   - provider I/O — {@link ChatRequest}, {@link ChatChunk},
 *     {@link EmbedRequest}, {@link ImageRequest}, {@link RealtimeSession},
 *     {@link HealthStatus} used by the provider layer and reused by the SDK
 *     (see `./providers`)
 *   - message content — {@link ContentBlock}, {@link SourceAttribution}
 *     (see `./content`)
 *   - the typed error/result model — {@link PlatformError}, {@link Result}
 *     used across the REST_API, WebSocket_Gateway, and SDK (see `./errors`)
 */

/** Package marker used to verify the shared types package is wired correctly. */
export const AUXIFY_TYPES_PACKAGE = '@auxify/types' as const;

export * from './identity.js';
export * from './models.js';
export * from './providers.js';
export * from './content.js';
export * from './errors.js';
