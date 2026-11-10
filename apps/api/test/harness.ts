import { startTestDatabase, type TestDatabase } from '@finance-os/db/testing';
import type { MemberRole } from '@finance-os/shared';
import type { JobQueue } from '../src/plugins/jobs.js';
import { buildServer } from '../src/server.js';
import { FakeGateway, testStellarContext } from './fake-stellar.js';

export type App = Awaited<ReturnType<typeof buildServer>>;

export interface Harness {
  app: App;
  db: TestDatabase;
  gateway: FakeGateway;
  close: () => Promise<void>;
}

/** A real API instance backed by a throwaway migrated Postgres. */
export async function startHarness(opts: { jobs?: JobQueue } = {}): Promise<Harness> {
  const db = await startTestDatabase();
  const gateway = new FakeGateway();
  const app = await buildServer({
    prisma: db.prisma,
    stellar: testStellarContext(gateway),
    ...(opts.jobs ? { jobs: opts.jobs } : {}),
  });
  await app.ready();
  return {
    app,
    db,
    gateway,
    close: async () => {
      await app.close();
      await db.stop();
    },
  };
}

export const PASSWORD = 'correct-horse-battery';

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function registerUser(app: App, email = `user-${uniq()}@test.dev`): Promise<TestUser> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, name: 'Test User' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { id: body.user.id, email: body.user.email, token: body.token };
}

export async function createOrg(app: App, owner: TestUser): Promise<{ id: string; slug: string }> {
  const slug = `org-${uniq()}`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: bearer(owner.token),
    payload: { name: `Org ${slug}`, slug },
  });
  if (res.statusCode !== 201) throw new Error(`create org failed: ${res.statusCode} ${res.body}`);
  return { id: res.json().id, slug };
}

export async function addMember(
  app: App,
  orgId: string,
  actor: TestUser,
  user: TestUser,
  role: MemberRole,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/orgs/${orgId}/members`,
    headers: bearer(actor.token),
    payload: { email: user.email, role },
  });
  if (res.statusCode !== 201) throw new Error(`add member failed: ${res.statusCode} ${res.body}`);
  return res.json().id;
}

/** An org with one member per role. */
export async function orgWithAllRoles(app: App) {
  const owner = await registerUser(app);
  const org = await createOrg(app, owner);
  const users = { owner } as Record<MemberRole, TestUser>;
  const memberIds = {} as Record<MemberRole, string>;
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(owner.token) });
  memberIds.owner = me.json().memberships[0].memberId;
  for (const role of ['admin', 'approver', 'accountant', 'viewer'] as const) {
    users[role] = await registerUser(app);
    memberIds[role] = await addMember(app, org.id, owner, users[role], role);
  }
  return { org, users, memberIds };
}

/** POST a resource and return its JSON, failing loudly on a non-201. */
export async function createResource(app: App, url: string, token: string, payload: object) {
  const res = await app.inject({ method: 'POST', url, headers: bearer(token), payload });
  if (res.statusCode !== 201) throw new Error(`POST ${url} failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

export async function createTreasury(app: App, orgId: string, token: string) {
  const { Keypair } = await import('@stellar/stellar-sdk');
  return createResource(app, `/v1/orgs/${orgId}/treasury-accounts`, token, {
    stellarAddress: Keypair.random().publicKey(),
    label: 'Treasury',
  }) as Promise<{ id: string; stellarAddress: string }>;
}

export async function createClient(app: App, orgId: string, token: string) {
  return createResource(app, `/v1/orgs/${orgId}/clients`, token, {
    name: 'Acme Corp',
  }) as Promise<{ id: string }>;
}

export async function createVendor(app: App, orgId: string, token: string) {
  const { Keypair } = await import('@stellar/stellar-sdk');
  return createResource(app, `/v1/orgs/${orgId}/vendors`, token, {
    name: 'Supplier',
    stellarAddress: Keypair.random().publicKey(),
  }) as Promise<{ id: string; stellarAddress: string }>;
}
