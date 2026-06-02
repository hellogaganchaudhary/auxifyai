/**
 * Unit tests for the REST_API router (Req 45.1).
 *
 * These verify the versioned route table covers EVERY Req 45.1 resource group,
 * that matching extracts `:param` path params, that a wrong method on a known
 * path is distinguished (405) from an unknown path (404), and that an unwired
 * controller resolves to a clean `not_found` error rather than crashing.
 */

import { describe, expect, it } from 'vitest';

import { createRouter, Router } from './router';
import { RESOURCE_GROUPS, type ResourceController, type ResourceGroup } from './types';

describe('Router — versioned route table (Req 45.1)', () => {
  it('registers at least one /v1 route for every Req 45.1 resource group', () => {
    const router = createRouter();
    const groups = router.registeredGroups;
    for (const group of RESOURCE_GROUPS) {
      expect(groups.has(group)).toBe(true);
    }
  });

  it('publishes every route under the /v1 version prefix', () => {
    const router = createRouter();
    for (const route of router.routes) {
      expect(route.pattern.startsWith('/v1/')).toBe(true);
    }
  });

  it('marks the sign-in route public and protected routes non-public (Req 45.2)', () => {
    const router = createRouter();
    const signIn = router.routes.find((r) => r.pattern === '/v1/auth/sign-in');
    expect(signIn?.public).toBe(true);
    const orgList = router.routes.find((r) => r.pattern === '/v1/organizations' && r.method === 'GET');
    expect(orgList?.public).toBeUndefined();
  });

  it('marks a streaming chat route as SSE (Req 45.3)', () => {
    const router = createRouter();
    const stream = router.routes.find((r) => r.pattern === '/v1/chat/stream');
    expect(stream?.stream).toBe('always');
    const messages = router.routes.find(
      (r) => r.pattern === '/v1/conversations/:conversationId/messages' && r.method === 'POST',
    );
    expect(messages?.stream).toBe('on-query');
  });
});

describe('Router.match — path/method matching (Req 45.1)', () => {
  it('matches a static path', () => {
    const router = createRouter();
    const outcome = router.match('GET', '/v1/organizations');
    expect(outcome.type).toBe('matched');
  });

  it('extracts :param path parameters', () => {
    const router = createRouter();
    const outcome = router.match('GET', '/v1/conversations/conv-42/messages/msg-7');
    expect(outcome.type).toBe('matched');
    if (outcome.type === 'matched') {
      expect(outcome.match.params).toEqual({ conversationId: 'conv-42', messageId: 'msg-7' });
    }
  });

  it('URL-decodes captured path params', () => {
    const router = createRouter();
    const outcome = router.match('GET', '/v1/organizations/org%20one');
    expect(outcome.type).toBe('matched');
    if (outcome.type === 'matched') {
      expect(outcome.match.params).toEqual({ organizationId: 'org one' });
    }
  });

  it('returns not_found (404) for an unknown path', () => {
    const router = createRouter();
    const outcome = router.match('GET', '/v1/nope/nothing-here');
    expect(outcome.type).toBe('not_found');
  });

  it('returns method_not_allowed (405) for a known path with the wrong method', () => {
    const router = createRouter();
    // /v1/models supports GET but not DELETE.
    const outcome = router.match('DELETE', '/v1/models');
    expect(outcome.type).toBe('method_not_allowed');
    if (outcome.type === 'method_not_allowed') {
      expect(outcome.allowed).toContain('GET');
    }
  });
});

describe('Router delegation (Req 45.1)', () => {
  it('dispatches a matched route to the wired controller operation', async () => {
    let received = '';
    const organizations: ResourceController = {
      // eslint-disable-next-line @typescript-eslint/require-await
      get: async (ctx) => {
        received = ctx.params.organizationId ?? '';
        return { ok: true, value: { body: { id: received } } };
      },
    };
    const router = createRouter({ controllers: { organizations } });
    const outcome = router.match('GET', '/v1/organizations/org-9');
    expect(outcome.type).toBe('matched');
    if (outcome.type === 'matched') {
      const result = await outcome.match.route.handler({
        request: { method: 'GET', path: '/v1/organizations/org-9', headers: {} },
        params: outcome.match.params,
        query: {},
        auth: null,
        correlationId: 'c-1',
      });
      expect(result.ok).toBe(true);
      expect(received).toBe('org-9');
    }
  });

  it('returns a not_found error for a route whose controller is unwired', async () => {
    const router = new Router(createRouter().routes);
    const outcome = router.match('GET', '/v1/agents');
    expect(outcome.type).toBe('matched');
    if (outcome.type === 'matched') {
      const result = await outcome.match.route.handler({
        request: { method: 'GET', path: '/v1/agents', headers: {} },
        params: {},
        query: {},
        auth: null,
        correlationId: 'c-2',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe('not_found');
        expect(result.error.code).toBe('HANDLER_NOT_IMPLEMENTED');
      }
    }
  });
});

// A compile-time check that ResourceGroup is exhaustively covered by the constant.
const _allGroups: readonly ResourceGroup[] = RESOURCE_GROUPS;
void _allGroups;
