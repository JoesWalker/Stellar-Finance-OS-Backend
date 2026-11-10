import { createPrismaClient } from '@finance-os/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testStellarContext } from './fake-stellar.js';
import { buildServer } from '../src/server.js';

/** /openapi.json is the contract with the frontend (AGENTS.md rule 5). */
describe('OpenAPI contract', () => {
  let doc: {
    paths: Record<
      string,
      Record<string, { responses?: Record<string, unknown>; security?: unknown }>
    >;
    components: { securitySchemes: Record<string, unknown> };
  };
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer({
      prisma: createPrismaClient('postgresql://unused@127.0.0.1:1/unused'),
      stellar: testStellarContext(),
    });
    await app.ready();
    doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
  });
  afterAll(() => app.close());

  const v1Ops = () =>
    Object.entries(doc.paths)
      .filter(([path]) => path.startsWith('/v1/'))
      .flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => ({ path, method, op })));

  it('documents the auth, org and member routes', () => {
    for (const p of [
      '/v1/auth/register',
      '/v1/auth/login',
      '/v1/auth/logout',
      '/v1/auth/me',
      '/v1/orgs',
      '/v1/orgs/{orgId}',
      '/v1/orgs/{orgId}/members',
      '/v1/orgs/{orgId}/members/{id}',
      '/v1/orgs/{orgId}/clients',
      '/v1/orgs/{orgId}/clients/{id}',
      '/v1/orgs/{orgId}/vendors',
      '/v1/orgs/{orgId}/vendors/{id}',
    ]) {
      expect(doc.paths[p], p).toBeDefined();
    }
  });

  it('declares a success response schema on every v1 operation', () => {
    for (const { path, method, op } of v1Ops()) {
      const success = Object.keys(op.responses ?? {}).filter((c) => c.startsWith('2'));
      expect(success.length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });

  it('marks every non-public v1 operation as bearer-authenticated', () => {
    expect(doc.components.securitySchemes.bearerAuth).toBeDefined();
    const open = new Set([
      '/v1/auth/register',
      '/v1/auth/login',
      // Payment page: the unguessable token is the capability.
      '/v1/public/invoices/{publicToken}',
    ]);
    for (const { path, method, op } of v1Ops()) {
      if (open.has(path)) continue;
      expect(op.security, `${method} ${path}`).toEqual([{ bearerAuth: [] }]);
    }
  });
});
