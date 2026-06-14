/**
 * The REST_API router (Req 45.1).
 *
 * A pure, framework-agnostic path/method router. It registers a versioned
 * {@link RouteDefinition} under `/v1/...` for EVERY Req 45.1 resource group —
 * auth, organizations, teams, projects, conversations, messages, models,
 * web-search, web-scrape, agents, knowledge-base, knowledge-hub, messaging,
 * documents, unified-search, prompts, analytics, and administration — and
 * matches an incoming `(method, path)` against them.
 *
 * Matching supports `:param` path segments, distinguishes a wrong-method hit on
 * a known path (→ `method_not_allowed`, surfaced as 405 by the dispatcher) from
 * a path that matches nothing (→ `not_found`, surfaced as 404), and is
 * dependency-free: each route's handler is a thin delegate that dispatches to
 * the injected {@link ResourceController} for its group, so the router never
 * imports a concrete domain service and stays fully unit-testable with stubs.
 */

import { createPlatformError, type Result } from '@auxify/types';

import {
  API_BASE_PATH,
  HTTP_METHODS,
  type HandlerSuccess,
  type HttpMethod,
  type MatchOutcome,
  type ResourceController,
  type ResourceGroup,
  type RestServices,
  type RouteDefinition,
  type RouteHandler,
  type RouteHandlerContext,
  type RouteMatch,
  type RouteParams,
} from './types';

/** A compiled route: the definition plus its pre-split, pre-analyzed segments. */
interface CompiledRoute {
  /** The source route definition. */
  definition: RouteDefinition;
  /** The pattern split into segments (`:param` segments carry `param: name`). */
  segments: PatternSegment[];
}

/** One segment of a compiled route pattern. */
interface PatternSegment {
  /** The literal segment text (for a static segment) or the `:`-stripped name (for a param). */
  value: string;
  /** Whether this segment captures a `:param`. */
  param: boolean;
}

/**
 * The router: holds the registered routes and matches requests against them.
 *
 * Construct it via {@link createRouter} so the Req 45.1 route table is wired to
 * the injected {@link RestServices}. {@link match} is pure; {@link routes}
 * exposes the registered table for introspection (and for the test that asserts
 * every Req 45.1 group has at least one `/v1` route).
 */
export class Router {
  private readonly compiled: CompiledRoute[];

  constructor(routes: readonly RouteDefinition[]) {
    this.compiled = routes.map((definition) => ({
      definition,
      segments: splitPattern(definition.pattern),
    }));
  }

  /** Every registered route definition, in registration order. */
  get routes(): readonly RouteDefinition[] {
    return this.compiled.map((c) => c.definition);
  }

  /** The distinct Req 45.1 resource groups that have at least one registered route. */
  get registeredGroups(): ReadonlySet<ResourceGroup> {
    return new Set(this.compiled.map((c) => c.definition.group));
  }

  /**
   * Match a method + path against the registered routes (Req 45.1).
   *
   * Returns the matched route and its extracted path params, or a
   * `method_not_allowed` outcome when a route matches the path but no route
   * matches the method, or `not_found` when nothing matches the path.
   *
   * @param method The request method.
   * @param path The decoded request path (no query string).
   */
  match(method: HttpMethod, path: string): MatchOutcome {
    const requestSegments = splitPath(path);
    const allowed = new Set<HttpMethod>();
    let pathMatched = false;

    for (const route of this.compiled) {
      const params = matchSegments(route.segments, requestSegments);
      if (params === null) {
        continue;
      }
      pathMatched = true;
      allowed.add(route.definition.method);
      if (route.definition.method === method) {
        const result: RouteMatch = { route: route.definition, params };
        return { type: 'matched', match: result };
      }
    }

    if (pathMatched) {
      return { type: 'method_not_allowed', allowed: [...allowed] };
    }
    return { type: 'not_found' };
  }
}

/**
 * Build the REST_API router with the full Req 45.1 versioned route table wired
 * to the injected handler ports.
 *
 * Every route delegates to the {@link ResourceController} registered for its
 * group in {@link RestServices.controllers}; an unwired group, or an operation
 * the controller does not implement, resolves to a `not_found` PlatformError at
 * request time (so the route still exists and authenticates, it just has no
 * backing handler yet).
 *
 * @param services The injectable handler ports the routes dispatch to.
 * @returns A {@link Router} over the registered Req 45.1 routes.
 */
export function createRouter(services: RestServices = {}): Router {
  return new Router(buildRoutes(services));
}

/**
 * The full Req 45.1 route table. Each entry names its resource group, its HTTP
 * method, its versioned pattern, and the controller operation it delegates to.
 */
function buildRoutes(services: RestServices): RouteDefinition[] {
  const route = (
    method: HttpMethod,
    pattern: string,
    group: ResourceGroup,
    op: string,
    extra: Pick<RouteDefinition, 'public' | 'stream'> = {},
  ): RouteDefinition => ({
    method,
    pattern: `${API_BASE_PATH}${pattern}`,
    group,
    op,
    handler: delegate(services, group, op),
    ...extra,
  });

  return [
    // --- auth (Req 45.1) — sign-in is the public, unauthenticated exception (Req 45.2).
    route('POST', '/auth/sign-in', 'auth', 'signIn', { public: true }),
    route('POST', '/auth/refresh', 'auth', 'refresh', { public: true }),
    route('POST', '/auth/sign-out', 'auth', 'signOut'),
    route('GET', '/auth/session', 'auth', 'session'),

    // --- organizations (Req 45.1)
    route('GET', '/organizations', 'organizations', 'list'),
    route('POST', '/organizations', 'organizations', 'create'),
    route('GET', '/organizations/:organizationId', 'organizations', 'get'),
    route('PATCH', '/organizations/:organizationId', 'organizations', 'update'),
    route('DELETE', '/organizations/:organizationId', 'organizations', 'delete'),

    // --- teams (Req 45.1)
    route('GET', '/teams', 'teams', 'list'),
    route('POST', '/teams', 'teams', 'create'),
    route('GET', '/teams/:teamId', 'teams', 'get'),
    route('PATCH', '/teams/:teamId', 'teams', 'update'),
    route('DELETE', '/teams/:teamId', 'teams', 'delete'),

    // --- projects (Req 45.1)
    route('GET', '/projects', 'projects', 'list'),
    route('POST', '/projects', 'projects', 'create'),
    route('GET', '/projects/:projectId', 'projects', 'get'),
    route('PATCH', '/projects/:projectId', 'projects', 'update'),
    route('DELETE', '/projects/:projectId', 'projects', 'delete'),

    // --- conversations (Req 45.1)
    route('GET', '/conversations', 'conversations', 'list'),
    route('POST', '/conversations', 'conversations', 'create'),
    route('GET', '/conversations/:conversationId', 'conversations', 'get'),
    route('PATCH', '/conversations/:conversationId', 'conversations', 'update'),
    route('DELETE', '/conversations/:conversationId', 'conversations', 'delete'),

    // --- messages (Req 45.1) — the streaming chat route is SSE (Req 45.3).
    route('GET', '/conversations/:conversationId/messages', 'messages', 'list'),
    route('POST', '/conversations/:conversationId/messages', 'messages', 'create', {
      stream: 'on-query',
    }),
    route('GET', '/conversations/:conversationId/messages/:messageId', 'messages', 'get'),
    // A dedicated always-SSE chat stream endpoint (Req 45.3).
    route('POST', '/chat/stream', 'messages', 'stream', { stream: 'always' }),

    // --- models (Req 45.1)
    route('GET', '/models', 'models', 'list'),
    route('GET', '/models/:modelId', 'models', 'get'),

    // --- web search / scrape (Req 45.1)
    route('POST', '/web-search', 'web-search', 'search'),
    route('POST', '/web-scrape', 'web-scrape', 'scrape'),

    // --- agents (Req 45.1)
    route('GET', '/agents', 'agents', 'list'),
    route('POST', '/agents', 'agents', 'create'),
    route('GET', '/agents/:agentId', 'agents', 'get'),
    route('POST', '/agents/:agentId/runs', 'agents', 'run', { stream: 'always' }),

    // --- knowledge base (Req 45.1)
    route('GET', '/knowledge-base/sources', 'knowledge-base', 'listSources'),
    route('POST', '/knowledge-base/sources', 'knowledge-base', 'connectSource'),
    route('POST', '/knowledge-base/search', 'knowledge-base', 'search'),
    route('POST', '/knowledge-base/all', 'knowledge-base', 'fetchAll'),

    // --- Knowledge Hub (Req 45.1)
    route('GET', '/knowledge-hub/pages', 'knowledge-hub', 'listPages'),
    route('POST', '/knowledge-hub/pages', 'knowledge-hub', 'createPage'),
    route('GET', '/knowledge-hub/pages/:pageId', 'knowledge-hub', 'getPage'),

    // --- messaging (Req 45.1)
    route('GET', '/messaging/channels', 'messaging', 'listChannels'),
    route('POST', '/messaging/channels', 'messaging', 'createChannel'),
    route('GET', '/messaging/channels/:channelId/messages', 'messaging', 'listMessages'),
    route('POST', '/messaging/channels/:channelId/messages', 'messaging', 'postMessage'),

    // --- documents (Req 45.1)
    route('GET', '/documents', 'documents', 'list'),
    route('POST', '/documents', 'documents', 'create'),
    route('GET', '/documents/:documentId', 'documents', 'get'),
    route('PATCH', '/documents/:documentId', 'documents', 'update'),
    route('DELETE', '/documents/:documentId', 'documents', 'delete'),

    // --- unified search (Req 45.1)
    route('POST', '/search', 'unified-search', 'search'),

    // --- prompts (Req 45.1)
    route('GET', '/prompts', 'prompts', 'list'),
    route('POST', '/prompts', 'prompts', 'create'),
    route('GET', '/prompts/:promptId', 'prompts', 'get'),
    route('PATCH', '/prompts/:promptId', 'prompts', 'update'),

    // --- analytics (Req 45.1)
    route('GET', '/analytics/usage', 'analytics', 'usage'),
    route('POST', '/analytics/reports', 'analytics', 'report'),

    // --- administration (Req 45.1)
    route('GET', '/admin/audit-logs', 'administration', 'auditLogs'),
    route('GET', '/admin/api-keys', 'administration', 'listApiKeys'),
    route('POST', '/admin/api-keys', 'administration', 'createApiKey'),
  ];
}

/**
 * Build the thin delegating handler for a `(group, op)` route: it looks up the
 * group's controller and its operation at request time and invokes it, or
 * returns a `not_found` PlatformError when no handler is wired (so the route
 * still exists, authenticates, and reports a clean 404 rather than crashing).
 */
function delegate(
  services: RestServices,
  group: ResourceGroup,
  op: string,
): RouteHandler {
  return async (ctx: RouteHandlerContext): Promise<Result<HandlerSuccess>> => {
    const controller: ResourceController | undefined = services.controllers?.[group];
    const handler = controller?.[op];
    if (handler === undefined) {
      return {
        ok: false,
        error: createPlatformError({
          category: 'not_found',
          code: 'HANDLER_NOT_IMPLEMENTED',
          message: `no handler is wired for ${group}.${op}`,
          correlationId: ctx.correlationId,
        }),
      };
    }
    return handler(ctx);
  };
}

/** Split a route pattern into analyzed segments (a leading `:` marks a param). */
function splitPattern(pattern: string): PatternSegment[] {
  return splitPath(pattern).map((segment) =>
    segment.startsWith(':')
      ? { value: segment.slice(1), param: true }
      : { value: segment, param: false },
  );
}

/** Split a path into its non-empty segments (a trailing slash is ignored). */
function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * Match a request's path segments against a route's compiled segments, returning
 * the extracted params on a match or `null` when the path shape differs.
 */
function matchSegments(
  routeSegments: PatternSegment[],
  requestSegments: string[],
): RouteParams | null {
  if (routeSegments.length !== requestSegments.length) {
    return null;
  }
  const params: RouteParams = {};
  for (let i = 0; i < routeSegments.length; i++) {
    const route = routeSegments[i];
    const value = requestSegments[i];
    if (route === undefined || value === undefined) {
      return null;
    }
    if (route.param) {
      params[route.value] = decodeSegment(value);
    } else if (route.value !== value) {
      return null;
    }
  }
  return params;
}

/** Decode a single path segment, falling back to the raw value on a malformed escape. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The HTTP methods recognized by the router, re-exported for adapters. */
export { HTTP_METHODS };
