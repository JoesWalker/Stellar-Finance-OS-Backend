import { DEMO_ORG, DEMO_PASSWORD } from '@finance-os/db/seed-data';
import { seedDemo } from '@finance-os/db/seed';
import { decodeMuxedAddress } from '@finance-os/stellar';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicInvoiceSchema } from '../src/routes/public-invoices.js';
import {
  bearer,
  createOrg,
  createResource,
  createTreasury,
  registerUser,
  startHarness,
  type Harness,
  type TestUser,
} from './harness.js';

describe('invoices', () => {
  let h: Harness;
  let owner: TestUser;
  let orgId: string;
  let treasury: { id: string; stellarAddress: string };
  let clientId: string;
  const enqueued: unknown[] = [];

  beforeAll(async () => {
    h = await startHarness({ jobs: { enqueue: async (_q, job) => void enqueued.push(job) } });
    owner = await registerUser(h.app);
    orgId = (await createOrg(h.app, owner)).id;
    treasury = await createTreasury(h.app, orgId, owner.token);
    clientId = (
      await h.db.prisma.client.create({
        data: { organizationId: orgId, name: 'Acme', email: 'ap@acme.test' },
      })
    ).id;
  });
  afterAll(() => h.close());

  const url = (suffix = '') => `/v1/orgs/${orgId}/invoices${suffix}`;
  const create = (overrides: object = {}) =>
    createResource(h.app, url(), owner.token, {
      clientId,
      treasuryAccountId: treasury.id,
      assetCode: 'USDC',
      dueDate: '2030-01-31',
      lineItems: [{ description: 'Work', quantity: '3', unitPrice: '33.3333333' }],
      ...overrides,
    });
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) =>
    h.app.inject({
      method,
      url: path,
      headers: bearer(owner.token),
      ...(payload ? { payload } : {}),
    });

  it('creates a draft with exact totals, number, muxed address and memo', async () => {
    const inv = await create();
    expect(inv.status).toBe('draft');
    expect(inv.amount).toBe('99.9999999');
    expect(inv.lineItems[0].amount).toBe('99.9999999');
    expect(inv.number).toMatch(new RegExp(`^INV-${new Date().getUTCFullYear()}-\\d{4}$`));
    expect(inv.memo).toBe(`INV${inv.paymentRefId}`);
    const decoded = decodeMuxedAddress(inv.muxedAddress);
    expect(decoded.baseAddress).toBe(treasury.stellarAddress);
    expect(decoded.id).toBe(inv.paymentRefId);
  });

  it('allocates distinct numbers under concurrent creates', async () => {
    const invs = await Promise.all(Array.from({ length: 5 }, () => create()));
    expect(new Set(invs.map((i) => i.number)).size).toBe(5);
  });

  it('rejects unsupported assets', async () => {
    const res = await call('POST', url(), {
      clientId,
      treasuryAccountId: treasury.id,
      assetCode: 'DOGE',
      dueDate: '2030-01-31',
      lineItems: [{ description: 'x', quantity: '1', unitPrice: '1' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('edits drafts, recomputing totals', async () => {
    const inv = await create();
    const res = await call('PATCH', url(`/${inv.id}`), {
      lineItems: [
        { description: 'a', quantity: '2', unitPrice: '0.1' },
        { description: 'b', quantity: '1', unitPrice: '0.2' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().amount).toBe('0.4000000');
    expect(res.json().lineItems).toHaveLength(2);
  });

  it('enforces the lifecycle with 409s', async () => {
    const inv = await create();
    const sent = await call('POST', url(`/${inv.id}/send`));
    expect(sent.statusCode).toBe(200);
    expect(sent.json().status).toBe('sent');
    expect(sent.json().sentAt).not.toBeNull();
    expect(enqueued).toContainEqual({
      kind: 'invoice_sent',
      organizationId: orgId,
      invoiceId: inv.id,
    });

    expect((await call('PATCH', url(`/${inv.id}`), { notes: 'x' })).statusCode).toBe(409);
    expect((await call('DELETE', url(`/${inv.id}`))).statusCode).toBe(409);
    expect((await call('POST', url(`/${inv.id}/send`))).statusCode).toBe(409);

    await h.db.prisma.invoice.update({ where: { id: inv.id }, data: { status: 'paid' } });
    expect((await call('POST', url(`/${inv.id}/send`))).statusCode).toBe(409);
    expect((await call('POST', url(`/${inv.id}/void`))).statusCode).toBe(409);
  });

  it('only one of two concurrent sends wins', async () => {
    const inv = await create();
    const codes = (
      await Promise.all([
        call('POST', url(`/${inv.id}/send`)),
        call('POST', url(`/${inv.id}/send`)),
      ])
    ).map((r) => r.statusCode);
    expect(codes.sort()).toEqual([200, 409]);
  });

  it('refuses to void an invoice with matched payments', async () => {
    const inv = await create();
    await call('POST', url(`/${inv.id}/send`));
    const tx = await h.db.prisma.transaction.create({
      data: {
        organizationId: orgId,
        treasuryAccountId: treasury.id,
        txHash: randomBytes(32).toString('hex'),
        operationIndex: 0,
        pagingToken: '0',
        direction: 'in',
        operationType: 'payment',
        status: 'success',
        from: treasury.stellarAddress,
        to: inv.muxedAddress,
        assetCode: 'USDC',
        amount: '1',
        ledger: 1,
        createdAt: new Date(),
      },
    });
    await h.db.prisma.paymentMatch.create({
      data: {
        organizationId: orgId,
        transactionId: tx.id,
        invoiceId: inv.id,
        amount: '1',
        method: 'muxed',
        confidence: '1',
      },
    });
    expect((await call('POST', url(`/${inv.id}/void`))).statusCode).toBe(409);
    const detail = (await call('GET', url(`/${inv.id}`))).json();
    expect(detail.matches).toHaveLength(1);

    const clean = await create();
    const voided = await call('POST', url(`/${clean.id}/void`));
    expect(voided.json().status).toBe('void');
  });

  it('deletes drafts', async () => {
    const inv = await create();
    expect((await call('DELETE', url(`/${inv.id}`))).statusCode).toBe(204);
    expect((await call('GET', url(`/${inv.id}`))).statusCode).toBe(404);
  });

  it('lists with filters and keyset pagination', async () => {
    const overdue = await create({ dueDate: '2000-01-01' });
    await call('POST', url(`/${overdue.id}/send`));
    const filtered = (await call('GET', url('?overdue=true'))).json();
    expect(filtered.items.map((i: { id: string }) => i.id)).toEqual([overdue.id]);
    const drafts = (await call('GET', url(`?status=draft&clientId=${clientId}`))).json();
    expect(drafts.items.every((i: { status: string }) => i.status === 'draft')).toBe(true);

    const page1 = (await call('GET', url('?limit=2'))).json();
    expect(page1.items).toHaveLength(2);
    const page2 = (await call('GET', url(`?limit=2&cursor=${page1.nextCursor}`))).json();
    expect(page2.items[0].id < page1.items[1].id).toBe(true);
  });

  describe('public payment page', () => {
    const pub = (token: string) =>
      h.app.inject({ method: 'GET', url: `/v1/public/invoices/${token}` });

    it('404s for unknown tokens and drafts', async () => {
      expect((await pub('x'.repeat(32))).statusCode).toBe(404);
      const draft = await create();
      expect((await pub(draft.publicToken)).statusCode).toBe(404);
    });

    it('returns only payer-facing fields', async () => {
      const inv = await create();
      await call('POST', url(`/${inv.id}/send`));
      const res = await pub(inv.publicToken);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        number: inv.number,
        muxedAddress: inv.muxedAddress,
        memo: inv.memo,
        amountDue: '99.9999999',
        asset: { code: 'USDC' },
      });
      const forbidden = ['id', 'organizationId', 'clientId', 'email', 'treasuryAccountId'];
      for (const key of forbidden) {
        expect(Object.keys(PublicInvoiceSchema.shape)).not.toContain(key);
        expect(body).not.toHaveProperty(key);
      }
      expect(JSON.stringify(body)).not.toContain('ap@acme.test');
    });
  });

  it('seeded demo invoices are listable and render publicly', async () => {
    await seedDemo(h.db.prisma, {});
    const login = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'owner@demo.test', password: DEMO_PASSWORD },
    });
    const token = login.json().token;
    const org = await h.db.prisma.organization.findUniqueOrThrow({
      where: { slug: DEMO_ORG.slug },
    });
    const list = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${org.id}/invoices`,
      headers: bearer(token),
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<{ status: string; publicToken: string }>;
    expect(items.length).toBeGreaterThan(0);
    const sent = items.find((i) => i.status !== 'draft')!;
    expect(
      (await h.app.inject({ method: 'GET', url: `/v1/public/invoices/${sent.publicToken}` }))
        .statusCode,
    ).toBe(200);
  });
});
