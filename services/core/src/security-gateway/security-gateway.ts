/**
 * Security_Gateway — the request-edge guard (Req 34.1, 34.2, 34.3, 34.4, 34.5,
 * 34.6, 34.8).
 *
 * The Security_Gateway is the component every client request passes through
 * before it reaches a backend service. It composes the platform's network and
 * application defenses into a single fail-closed verdict, denying by default and
 * admitting a request only when *every* applicable stage positively passes. It
 * owns no domain logic of its own — it orchestrates the guards, records every
 * denial, and hands the backend an authenticated principal plus a sanitized body.
 *
 * ## Fail-closed decision pipeline
 *
 * {@link SecurityGateway.evaluate} runs these stages in order; the first failing
 * stage denies (and audits), and reaching the end grants:
 *
 *   1. **TLS 1.3 (Req 34.1).** The connection must have negotiated TLS 1.3; a
 *      lower version (or no TLS) is denied (`tls_required`) at the transport edge.
 *   2. **IP / abuse gating (Req 34, WAF).** The originating IP is screened
 *      through the {@link IpReputation} port; a blocked source is denied
 *      (`ip_blocked`) before any work is spent on it.
 *   3. **Rate limiting (Req 34.3).** Per-user, per-API-key, and per-IP limits are
 *      enforced through the {@link RateLimiter} port (keyed off the request's
 *      claimed identity and IP) *before* authentication, so a flood cannot
 *      overwhelm the Auth_Service; an over-limit request is denied
 *      (`rate_limited`) with a retry-after hint.
 *   4. **Input validation + sanitization (Req 34.4).** The {@link RequestValidator}
 *      rejects a malformed request (`invalid_request`) and otherwise returns the
 *      body with disallowed constructs neutralized, so only sanitized input is
 *      ever processed.
 *   5. **CSRF (Req 34.6).** A state-changing request (`POST`/`PUT`/`PATCH`/
 *      `DELETE`) must carry a valid CSRF token; a missing/mismatched token is
 *      denied (`csrf_failed`). Safe methods skip this stage.
 *   6. **Authentication before routing (Req 34.2).** The {@link Authenticator}
 *      establishes the authoritative {@link Principal}; a request that cannot be
 *      authenticated is denied (`unauthenticated`).
 *   7. **Authorization (Req 34.8).** When an {@link Authorizer} is wired, the
 *      authenticated request is authorized through it; a denial fails the request
 *      closed (`unauthorized`). When omitted, fine-grained authorization is
 *      deferred to the downstream Access_Control gate.
 *
 * Because each stage can only deny, the pipeline is fail-closed by construction:
 * a request that cannot be positively admitted at every applicable stage is
 * refused (Req 34.8). A security check that *errors* (any injected port throws)
 * is treated as a failed check — the gateway denies (`fail_closed`) rather than
 * assuming success, so an exception can never open the edge.
 *
 * ## Auditing every denial (Req 37.1)
 *
 * Every denial — at any stage — is recorded through the injected
 * {@link AuditRecorder} port as a `security.denied` event, scoped to the
 * request's Organization when an identity is known and to a system/anonymous
 * context otherwise (so a pre-auth denial is still logged). Allowed requests
 * record nothing, mirroring Access_Control's audit-on-deny contract (Property 3).
 *
 * ## Dependency injection
 *
 * Every guard is a narrow injected port — {@link IpReputation},
 * {@link RateLimiter}, {@link Authenticator}, {@link RequestValidator},
 * {@link CsrfVerifier}, the optional {@link Authorizer}, the
 * {@link AuditRecorder}, and the {@link SecurityGatewayClock} — so the gateway
 * is pure orchestration and fully unit-testable with the fakes in `./fakes.js`,
 * with no real network, TLS terminator, rate-limit backend, or Auth_Service.
 */

import type { Principal, TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import { RequestDeniedError } from './errors.js';
import { StaticIpReputation } from './ip-reputation.js';
import { InMemoryRateLimiter } from './rate-limiter.js';
import { DefaultRequestValidator } from './validation.js';
import { DoubleSubmitCsrfVerifier } from './csrf.js';
import {
  REQUIRED_TLS_VERSION,
  STATE_CHANGING_METHODS,
  systemSecurityGatewayClock,
  type Authenticator,
  type Authorizer,
  type CsrfVerifier,
  type GatewayDenialCode,
  type GatewayRequest,
  type GatewayVerdict,
  type HttpMethod,
  type IpReputation,
  type RateLimitConfig,
  type RateLimiter,
  type RateLimitKey,
  type RequestValidator,
  type SecurityGatewayClock,
} from './types.js';

/** The default per-dimension rate limits applied when the caller supplies none (Req 34.3). */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  user: { requestsPerWindow: 600, windowSeconds: 60 },
  apiKey: { requestsPerWindow: 600, windowSeconds: 60 },
  ip: { requestsPerWindow: 120, windowSeconds: 60 },
};

/** Construction dependencies for the {@link SecurityGateway} (all injectable). */
export interface SecurityGatewayOptions {
  /** The append-only audit sink; every denial is recorded through it (Req 37.1). */
  auditRecorder: AuditRecorder;
  /** The authentication port routing requests through the Auth_Service (Req 34.2). */
  authenticator: Authenticator;
  /** The IP / abuse-gating port; defaults to an empty {@link StaticIpReputation} (no IP blocked). */
  ipReputation?: IpReputation;
  /** The per-dimension rate limiter; defaults to an {@link InMemoryRateLimiter} (Req 34.3). */
  rateLimiter?: RateLimiter;
  /** The per-dimension rate-limit configuration; defaults to {@link DEFAULT_RATE_LIMIT_CONFIG}. */
  rateLimitConfig?: RateLimitConfig;
  /** The input validator/sanitizer; defaults to a {@link DefaultRequestValidator} (Req 34.4). */
  requestValidator?: RequestValidator;
  /** The CSRF verifier; defaults to a {@link DoubleSubmitCsrfVerifier} (Req 34.6). */
  csrfVerifier?: CsrfVerifier;
  /**
   * The optional authorization port (Req 34.8). When omitted, fine-grained
   * authorization is deferred to the downstream Access_Control gate and the
   * gateway grants once a request is authenticated and validated.
   */
  authorizer?: Authorizer;
  /** The clock for rate-limit windowing and audit timestamps; defaults to {@link systemSecurityGatewayClock}. */
  clock?: SecurityGatewayClock;
}

/**
 * The Security_Gateway. Construct once with its injected guards, then call
 * {@link evaluate} (non-throwing) or {@link evaluateOrThrow} (edge-transport
 * convenience) on every incoming request.
 */
export class SecurityGateway {
  private readonly auditRecorder: AuditRecorder;
  private readonly authenticator: Authenticator;
  private readonly ipReputation: IpReputation;
  private readonly rateLimiter: RateLimiter;
  private readonly rateLimitConfig: RateLimitConfig;
  private readonly requestValidator: RequestValidator;
  private readonly csrfVerifier: CsrfVerifier;
  private readonly authorizer: Authorizer | undefined;
  private readonly clock: SecurityGatewayClock;

  constructor(options: SecurityGatewayOptions) {
    this.auditRecorder = options.auditRecorder;
    this.authenticator = options.authenticator;
    this.ipReputation = options.ipReputation ?? new StaticIpReputation();
    this.rateLimiter = options.rateLimiter ?? new InMemoryRateLimiter();
    this.rateLimitConfig = options.rateLimitConfig ?? DEFAULT_RATE_LIMIT_CONFIG;
    this.requestValidator = options.requestValidator ?? new DefaultRequestValidator();
    this.csrfVerifier = options.csrfVerifier ?? new DoubleSubmitCsrfVerifier();
    this.authorizer = options.authorizer;
    this.clock = options.clock ?? systemSecurityGatewayClock;
  }

  /**
   * Evaluate an incoming request through the fail-closed pipeline, returning the
   * structured verdict and recording every denial (Req 34.1-34.8).
   *
   * The verdict is `allowed: true` only when TLS, IP gating, rate limiting,
   * validation, CSRF (for state-changing requests), authentication, and — when
   * an authorizer is wired — authorization all pass; it then carries the
   * authenticated {@link Principal} and the sanitized request body. Any failing
   * stage returns a denial whose `denialCode` names the stage, after recording a
   * `security.denied` audit event. A guard that throws is treated as a failed
   * check and denied (`fail_closed`).
   *
   * @param request The incoming request descriptor.
   * @returns The {@link GatewayVerdict}; denials are audited as a side effect.
   */
  async evaluate(request: GatewayRequest): Promise<GatewayVerdict> {
    // Stage 1 — TLS 1.3 (Req 34.1).
    if (request.transport.tlsVersion !== REQUIRED_TLS_VERSION) {
      return this.deny(
        request,
        'tls_required',
        `connection must use TLS ${REQUIRED_TLS_VERSION}; negotiated "${request.transport.tlsVersion}"`,
      );
    }

    // Stage 2 — IP / abuse gating (Req 34, WAF).
    let ipVerdict;
    try {
      ipVerdict = await this.ipReputation.evaluate(request.ip);
    } catch {
      return this.deny(request, 'fail_closed', 'IP reputation check could not be completed');
    }
    if (ipVerdict.blocked) {
      return this.deny(
        request,
        'ip_blocked',
        ipVerdict.reason ?? `IP "${request.ip}" is blocked`,
      );
    }

    // Stage 3 — rate limiting per user / API key / IP (Req 34.3).
    const keys = this.rateLimitKeys(request);
    let rateDecision;
    try {
      rateDecision = await this.rateLimiter.consume(keys, this.clock.now());
    } catch {
      return this.deny(request, 'fail_closed', 'rate-limit check could not be completed');
    }
    if (!rateDecision.allowed) {
      return this.deny(
        request,
        'rate_limited',
        `rate limit exceeded for ${rateDecision.exceededDimension ?? 'request'}`,
        { retryAfterSeconds: rateDecision.retryAfterSeconds },
      );
    }

    // Stage 4 — input validation + sanitization (Req 34.4).
    let validation;
    try {
      validation = this.requestValidator.validate(request);
    } catch {
      return this.deny(request, 'fail_closed', 'request validation could not be completed');
    }
    if (!validation.valid) {
      return this.deny(
        request,
        'invalid_request',
        `request failed validation: ${validation.issues.join('; ')}`,
      );
    }

    // Stage 5 — CSRF on state-changing requests (Req 34.6).
    if (this.isStateChanging(request.method)) {
      let csrfOk;
      try {
        csrfOk = this.csrfVerifier.verify(request);
      } catch {
        return this.deny(request, 'csrf_failed', 'CSRF verification could not be completed');
      }
      if (!csrfOk) {
        return this.deny(
          request,
          'csrf_failed',
          `state-changing ${request.method} request requires a valid CSRF token`,
        );
      }
    }

    // Stage 6 — authentication before routing (Req 34.2).
    let auth;
    try {
      auth = await this.authenticator.authenticate(request);
    } catch {
      return this.deny(request, 'fail_closed', 'authentication could not be completed');
    }
    if (!auth.authenticated) {
      return this.deny(request, 'unauthenticated', `authentication failed: ${auth.reason}`);
    }
    const principal = auth.principal;

    // Stage 7 — authorization (Req 34.8), when an authorizer is wired.
    if (this.authorizer !== undefined) {
      let authz;
      try {
        authz = await this.authorizer.authorize(principal, request);
      } catch {
        return this.deny(request, 'fail_closed', 'authorization could not be completed', {
          principal,
        });
      }
      if (!authz.allowed) {
        return this.deny(
          request,
          'unauthorized',
          authz.reason ?? 'request is not authorized',
          { principal },
        );
      }
    }

    // Every applicable stage passed — admit, carrying the authenticated principal
    // and the sanitized body the backend should process.
    return {
      allowed: true,
      reason: `request admitted: ${request.method} ${request.path}`,
      principal,
      sanitizedBody: validation.sanitizedBody,
    };
  }

  /**
   * Like {@link evaluate}, but throws {@link RequestDeniedError} on a denial
   * (after the denial is audited) and resolves to the allow {@link GatewayVerdict}
   * otherwise. Edge-transport callers use this to fail closed with a single throw
   * site while retaining the full verdict on the error.
   *
   * @param request The incoming request descriptor.
   * @returns The allow verdict; throws {@link RequestDeniedError} on a denial.
   */
  async evaluateOrThrow(request: GatewayRequest): Promise<GatewayVerdict> {
    const verdict = await this.evaluate(request);
    if (!verdict.allowed) {
      throw new RequestDeniedError(verdict);
    }
    return verdict;
  }

  /** Whether `method` mutates state and therefore requires a CSRF token (Req 34.6). */
  private isStateChanging(method: HttpMethod): boolean {
    return STATE_CHANGING_METHODS.includes(method);
  }

  /**
   * Derive the per-dimension rate-limit keys for a request (Req 34.3): always the
   * IP, plus the user and/or API key when the request carries them. The
   * pre-auth claimed identity ({@link GatewayRequest.principal}/`apiKeyId`) is
   * used so the limiter throttles before the authentication stage runs.
   */
  private rateLimitKeys(request: GatewayRequest): RateLimitKey[] {
    const keys: RateLimitKey[] = [{ dimension: 'ip', id: request.ip, limit: this.rateLimitConfig.ip }];
    if (request.principal !== undefined) {
      keys.push({
        dimension: 'user',
        id: request.principal.userId,
        limit: this.rateLimitConfig.user,
      });
    }
    if (request.apiKeyId !== undefined) {
      keys.push({ dimension: 'api_key', id: request.apiKeyId, limit: this.rateLimitConfig.apiKey });
    }
    return keys;
  }

  /**
   * Build a denied {@link GatewayVerdict}, record a `security.denied` audit event
   * for it, and return the verdict (Req 37.1).
   *
   * The audit event is scoped to the request's Organization when an identity is
   * known (an already-authenticated principal supplied via `extra`, or the
   * request's claimed principal) and to a system/anonymous context otherwise, so
   * a pre-authentication denial is still recorded. Its metadata carries the
   * method, path, IP, the denial stage, and the reason.
   */
  private async deny(
    request: GatewayRequest,
    denialCode: GatewayDenialCode,
    reason: string,
    extra: { retryAfterSeconds?: number; principal?: Principal } = {},
  ): Promise<GatewayVerdict> {
    const verdict: GatewayVerdict = { allowed: false, reason, denialCode };
    if (extra.retryAfterSeconds !== undefined) {
      verdict.retryAfterSeconds = extra.retryAfterSeconds;
    }

    const identity = extra.principal ?? request.principal;
    const ctx: TenantContext = {
      organizationId: identity?.organizationId ?? 'system',
      userId: identity?.userId ?? 'anonymous',
    };
    await this.auditRecorder.record(ctx, {
      action: 'security.denied',
      resourceType: 'request',
      resourceId: `${request.method} ${request.path}`,
      actorId: identity?.userId ?? 'anonymous',
      ip: request.ip,
      userAgent: request.userAgent,
      metadata: {
        denialCode,
        reason,
        method: request.method,
        path: request.path,
        ...(extra.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: extra.retryAfterSeconds }
          : {}),
      },
    });

    return verdict;
  }
}
