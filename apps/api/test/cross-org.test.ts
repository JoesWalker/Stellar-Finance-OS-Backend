import { Keypair } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createClient,
  createTreasury,
  createVendor,
  createResource,
  createTreasury,
  orgWithAllRoles,
  startHarness,
  type Harness,
} from './harness.js';

const VENDOR_ADDRESS = Keypair.random().publicKey();
const invoiceBody = (clientId: string, treasuryAccountId: string) => ({
  clientId,
  treasuryAccountId,
  assetCode: 'XLM',
  dueDate: '2030-01-01',
  lineItems: [{ description: 'x', quantity: '1', unitPrice: '1' }],
});

/**
 * AGENTS.md rule 3: every org-scoped route must refuse callers from another
 * org — even owners — and must not touch the other org's data.
 */
describe('cross-org access', () => {
  let h: Harness;
  let a: Awaited<ReturnType<typeof orgWithAllRoles>>;
  let b: Awaited<ReturnType<typeof orgWithAllRoles>>;
  /** Resources owned by org B. */
  const bIds = {} as { treasury: string; client: string; vendor: string };
  const bIds = {} as { treasury: string; client: string; invoice: string };
  let aTreasury: string;
  let aClient: string;

  beforeAll(async () => {
    h = await startHarness();
    a = await orgWithAllRoles(h.app);
    b = await orgWithAllRoles(h.app);
    bIds.treasury = (await createTreasury(h.app, b.org.id, b.users.owner.token)).id;
    bIds.client = (await createClient(h.app, b.org.id, b.users.owner.token)).id;
    bIds.vendor = (await createVendor(h.app, b.org.id, b.users.owner.token)).id;
    aTreasury = (await createTreasury(h.app, a.org.id, a.users.owner.token)).id;
    const client = (organizationId: string) =>
      h.db.prisma.client.create({ data: { organizationId, name: 'C' } }).then((c) => c.id);
    bIds.client = await client(b.org.id);
    aClient = await client(a.org.id);
    bIds.invoice = (
      await createResource(h.app, `/v1/orgs/${b.org.id}/invoices`, b.users.owner.token, {
        ...invoiceBody(bIds.client, bIds.treasury),
      })
    ).id;
  });
  afterAll(() => h.close());

  const routes = () =>
    [
      { method: 'GET', url: `/v1/orgs/${b.org.id}` },
      { method: 'PATCH', url: `/v1/orgs/${b.org.id}`, payload: { name: 'pwned' } },
      { method: 'GET', url: `/v1/orgs/${b.org.id}/members` },
      { method: 'GET', url: `/v1/orgs/${b.org.id}/members/${b.memberIds.viewer}` },
      {
        method: 'POST',
        url: `/v1/orgs/${b.org.id}/members`,
        payload: { email: a.users.viewer.email, role: 'owner' },
      },
      {
        method: 'PATCH',
        url: `/v1/orgs/${b.org.id}/members/${b.memberIds.viewer}`,
        payload: { role: 'admin' },
      },
      { method: 'DELETE', url: `/v1/orgs/${b.org.id}/members/${b.memberIds.viewer}` },
      { method: 'GET', url: `/v1/orgs/${b.org.id}/clients` },
      { method: 'GET', url: `/v1/orgs/${b.org.id}/clients/${bIds.client}` },
      { method: 'POST', url: `/v1/orgs/${b.org.id}/clients`, payload: { name: 'pwned' } },
      {
        method: 'PATCH',
        url: `/v1/orgs/${b.org.id}/clients/${bIds.client}`,
        payload: { name: 'pwned' },
      },
      { method: 'DELETE', url: `/v1/orgs/${b.org.id}/clients/${bIds.client}` },
      { method: 'GET', url: `/v1/orgs/${b.org.id}/vendors` },
      { method: 'GET', url: `/v1/orgs/${b.org.id}/vendors/${bIds.vendor}` },
      {
        method: 'POST',
        url: `/v1/orgs/${b.org.id}/vendors`,
        payload: { name: 'pwned', stellarAddress: VENDOR_ADDRESS },
      },
      {
        method: 'PATCH',
        url: `/v1/orgs/${b.org.id}/vendors/${bIds.vendor}`,
        payload: { name: 'pwned' },
      },
      { method: 'DELETE', url: `/v1/orgs/${b.org.id}/vendors/${bIds.vendor}` },
      { method: 'GET', url: `/v1/orgs/${b.org.id}/invoices` },
      {
        method: 'POST',
        url: `/v1/orgs/${b.org.id}/invoices`,
        payload: invoiceBody(bIds.client, bIds.treasury),
      },
      { method: 'GET', url: `/v1/orgs/${b.org.id}/invoices/${bIds.invoice}` },
      {
        method: 'PATCH',
        url: `/v1/orgs/${b.org.id}/invoices/${bIds.invoice}`,
        payload: { notes: 'pwned' },
      },
      { method: 'DELETE', url: `/v1/orgs/${b.org.id}/invoices/${bIds.invoice}` },
      { method: 'POST', url: `/v1/orgs/${b.org.id}/invoices/${bIds.invoice}/send` },
      { method: 'POST', url: `/v1/orgs/${b.org.id}/invoices/${bIds.invoice}/void` },
    ] as const;

  it('returns 404 to an owner of another org on every org route', async () => {
    for (const r of routes()) {
      const res = await h.app.inject({ ...r, headers: bearer(a.users.owner.token) });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
    }
    const org = await h.db.prisma.organization.findUniqueOrThrow({ where: { id: b.org.id } });
    expect(org.name).not.toBe('pwned');
    expect(await h.db.prisma.member.count({ where: { organizationId: b.org.id } })).toBe(5);
  });

  it("cannot reach another org's treasury account through its own org id", async () => {
    const own = `/v1/orgs/${a.org.id}/treasury-accounts/${bIds.treasury}`;
    const token = bearer(a.users.owner.token);
    for (const res of await Promise.all([
      h.app.inject({ method: 'GET', url: own, headers: token }),
      h.app.inject({ method: 'PATCH', url: own, headers: token, payload: { label: 'pwned' } }),
      h.app.inject({ method: 'DELETE', url: own, headers: token }),
    ])) {
      expect(res.statusCode).toBe(404);
    }
  });

  it("cannot reach another org's clients or vendors through its own org id", async () => {
    const token = bearer(a.users.owner.token);
    for (const [resource, id] of [
      ['clients', bIds.client],
      ['vendors', bIds.vendor],
    ] as const) {
      const own = `/v1/orgs/${a.org.id}/${resource}/${id}`;
      for (const res of await Promise.all([
        h.app.inject({ method: 'GET', url: own, headers: token }),
        h.app.inject({ method: 'PATCH', url: own, headers: token, payload: { name: 'pwned' } }),
        h.app.inject({ method: 'DELETE', url: own, headers: token }),
      ])) {
        expect(res.statusCode, `${resource}`).toBe(404);
      }
    }
    expect(await h.db.prisma.client.count({ where: { organizationId: b.org.id } })).toBe(1);
    expect(await h.db.prisma.vendor.count({ where: { organizationId: b.org.id } })).toBe(1);
    const list = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${a.org.id}/clients`,
      headers: token,
    });
    expect(list.json().items).toEqual([]);
  it("cannot reach another org's invoice through its own org id", async () => {
    const own = `/v1/orgs/${a.org.id}/invoices/${bIds.invoice}`;
    const token = bearer(a.users.owner.token);
    for (const res of await Promise.all([
      h.app.inject({ method: 'GET', url: own, headers: token }),
      h.app.inject({ method: 'PATCH', url: own, headers: token, payload: { notes: 'pwned' } }),
      h.app.inject({ method: 'DELETE', url: own, headers: token }),
      h.app.inject({ method: 'POST', url: `${own}/send`, headers: token }),
      h.app.inject({ method: 'POST', url: `${own}/void`, headers: token }),
    ])) {
      expect(res.statusCode).toBe(404);
    }
    const inv = await h.db.prisma.invoice.findUniqueOrThrow({ where: { id: bIds.invoice } });
    expect(inv.status).toBe('draft');
    expect(inv.notes).toBeNull();
  });

  it("an invoice can't reference another org's client or treasury account", async () => {
    const url = `/v1/orgs/${a.org.id}/invoices`;
    const token = bearer(a.users.owner.token);
    for (const payload of [
      invoiceBody(bIds.client, aTreasury),
      invoiceBody(aClient, bIds.treasury),
    ]) {
      const res = await h.app.inject({ method: 'POST', url, headers: token, payload });
      expect(res.statusCode).toBe(404);
    }
  });

  it("cannot reach another org's member through its own org id", async () => {
    const own = `/v1/orgs/${a.org.id}/members/${b.memberIds.viewer}`;
    const token = bearer(a.users.owner.token);
    for (const res of await Promise.all([
      h.app.inject({ method: 'GET', url: own, headers: token }),
      h.app.inject({ method: 'PATCH', url: own, headers: token, payload: { role: 'admin' } }),
      h.app.inject({ method: 'DELETE', url: own, headers: token }),
    ])) {
      expect(res.statusCode).toBe(404);
    }
    const target = await h.db.prisma.member.findUniqueOrThrow({
      where: { id: b.memberIds.viewer },
    });
    expect(target.role).toBe('viewer');
  });

  it('returns 401 without a session', async () => {
    for (const r of routes()) {
      const res = await h.app.inject({ ...r });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });
});
