import { Keypair, MuxedAccount, Account } from '@stellar/stellar-sdk';
import { containsSecretKey } from '@finance-os/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createClient,
  createTreasury,
  createVendor,
  orgWithAllRoles,
  startHarness,
  type Harness,
} from './harness.js';

describe('client and vendor routes', () => {
  let h: Harness;
  let ctx: Awaited<ReturnType<typeof orgWithAllRoles>>;
  let other: Awaited<ReturnType<typeof orgWithAllRoles>>;
  beforeAll(async () => {
    h = await startHarness();
    ctx = await orgWithAllRoles(h.app);
    other = await orgWithAllRoles(h.app);
  });
  afterAll(() => h.close());

  const base = (r: 'clients' | 'vendors') => `/v1/orgs/${ctx.org.id}/${r}`;
  const req = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token?: string,
    payload?: object,
  ) =>
    h.app.inject({
      method,
      url,
      ...(token ? { headers: bearer(token) } : {}),
      ...(payload ? { payload } : {}),
    });

  describe('clients', () => {
    it('creates, lists with search and pagination, gets, updates and deletes', async () => {
      const token = ctx.users.accountant.token;
      const created = await req('POST', base('clients'), token, {
        name: 'Zebra Ltd',
        email: 'AP@Zebra.io',
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        name: 'Zebra Ltd',
        email: 'ap@zebra.io',
        knownAddresses: [],
      });
      const id = created.json().id;
      await req('POST', base('clients'), token, { name: 'Yak Inc' });

      const search = await req('GET', `${base('clients')}?q=zeb`, token);
      expect(search.json().items.map((c: { id: string }) => c.id)).toEqual([id]);
      const page1 = (await req('GET', `${base('clients')}?limit=1`, token)).json();
      expect(page1.items).toHaveLength(1);
      const page2 = (
        await req('GET', `${base('clients')}?limit=1&cursor=${page1.nextCursor}`, token)
      ).json();
      expect(page2.items[0].id).not.toBe(page1.items[0].id);

      expect(
        (await req('GET', `${base('clients')}/${id}`, ctx.users.viewer.token)).statusCode,
      ).toBe(200);
      const patched = await req('PATCH', `${base('clients')}/${id}`, token, { name: 'Zebra Plc' });
      expect(patched.json().name).toBe('Zebra Plc');
      expect((await req('DELETE', `${base('clients')}/${id}`, token)).statusCode).toBe(204);
      expect((await req('GET', `${base('clients')}/${id}`, token)).statusCode).toBe(404);
    });

    it('rejects bad input, knownAddresses writes, anonymous and viewer writes', async () => {
      const owner = ctx.users.owner.token;
      expect((await req('POST', base('clients'), owner, { name: '' })).statusCode).toBe(400);
      expect(
        (await req('POST', base('clients'), owner, { name: 'X', knownAddresses: ['G'] }))
          .statusCode,
      ).toBe(400);
      expect((await req('POST', base('clients'), undefined, { name: 'X' })).statusCode).toBe(401);
      expect(
        (await req('POST', base('clients'), ctx.users.viewer.token, { name: 'X' })).statusCode,
      ).toBe(403);
    });

    it('returns 404 for another org client and 409 when invoices reference it', async () => {
      const foreign = await createClient(h.app, other.org.id, other.users.owner.token);
      expect(
        (await req('GET', `${base('clients')}/${foreign.id}`, ctx.users.owner.token)).statusCode,
      ).toBe(404);

      const client = await createClient(h.app, ctx.org.id, ctx.users.owner.token);
      const treasury = await createTreasury(h.app, ctx.org.id, ctx.users.owner.token);
      await h.db.prisma.invoice.create({
        data: {
          organizationId: ctx.org.id,
          clientId: client.id,
          treasuryAccountId: treasury.id,
          number: 'INV-1',
          assetCode: 'XLM',
          amount: '10',
          dueDate: new Date('2026-12-01'),
          publicToken: `tok-${client.id}`,
        },
      });
      expect(
        (await req('DELETE', `${base('clients')}/${client.id}`, ctx.users.owner.token)).statusCode,
      ).toBe(409);
    });
  });

  describe('vendors', () => {
    const g = () => Keypair.random().publicKey();
    // The global secret guard's unanchored regex can false-positive on a
    // 69-char M... address, so pick one it doesn't flag.
    const muxed = (): string => {
      for (;;) {
        const m = new MuxedAccount(new Account(g(), '0'), '7').accountId();
        if (!containsSecretKey(m)) return m;
      }
    };

    it('round-trips an exchange-style memo exactly', async () => {
      const res = await req('POST', base('vendors'), ctx.users.accountant.token, {
        name: 'Exchange',
        stellarAddress: g(),
        memoRequired: true,
        memoType: 'id',
        memo: '18446744073709551615',
      });
      expect(res.statusCode).toBe(201);
      const got = (
        await req('GET', `${base('vendors')}/${res.json().id}`, ctx.users.viewer.token)
      ).json();
      expect(got).toMatchObject({
        memoRequired: true,
        memoType: 'id',
        memo: '18446744073709551615',
      });
    });

    it('accepts muxed addresses but validates memos and memoRequired', async () => {
      const t = ctx.users.owner.token;
      const post = (body: object) => req('POST', base('vendors'), t, { name: 'V', ...body });
      expect((await post({ stellarAddress: muxed() })).statusCode).toBe(201);
      for (const body of [
        { stellarAddress: 'GABC' },
        { stellarAddress: g(), memoRequired: true },
        { stellarAddress: muxed(), memoRequired: true, memoType: 'id', memo: '1' },
        { stellarAddress: g(), memoType: 'text', memo: 'x'.repeat(29) },
        { stellarAddress: g(), memoType: 'hash', memo: 'zz' },
        { stellarAddress: g(), memoType: 'id', memo: '-1' },
      ]) {
        expect((await post(body)).statusCode, JSON.stringify(body)).toBe(400);
      }
      const v = await createVendor(h.app, ctx.org.id, t);
      const bad = await req('PATCH', `${base('vendors')}/${v.id}`, t, { memoRequired: true });
      expect(bad.statusCode).toBe(400);
      const ok = await req('PATCH', `${base('vendors')}/${v.id}`, t, {
        memoType: 'text',
        memo: 'ACCT 42',
      });
      expect(ok.json()).toMatchObject({ memoType: 'text', memo: 'ACCT 42' });
    });

    it('refuses secret keys in any field without echoing them', async () => {
      const secret = Keypair.random().secret();
      const res = await req('POST', base('vendors'), ctx.users.owner.token, {
        name: 'V',
        stellarAddress: g(),
        memoType: 'text',
        memo: secret,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(secret);
    });

    it('enforces auth, roles, org scoping and in-use deletes', async () => {
      const t = ctx.users.owner.token;
      expect((await req('GET', base('vendors'))).statusCode).toBe(401);
      expect(
        (
          await req('POST', base('vendors'), ctx.users.viewer.token, {
            name: 'V',
            stellarAddress: g(),
          })
        ).statusCode,
      ).toBe(403);
      const foreign = await createVendor(h.app, other.org.id, other.users.owner.token);
      expect((await req('DELETE', `${base('vendors')}/${foreign.id}`, t)).statusCode).toBe(404);

      const v = await createVendor(h.app, ctx.org.id, t);
      const treasury = await createTreasury(h.app, ctx.org.id, t);
      await h.db.prisma.paymentRequest.create({
        data: {
          organizationId: ctx.org.id,
          vendorId: v.id,
          assetCode: 'XLM',
          amount: '5',
          reason: 'test',
          createdByMemberId: ctx.memberIds.owner,
          sourceTreasuryAccountId: treasury.id,
        },
      });
      expect((await req('DELETE', `${base('vendors')}/${v.id}`, t)).statusCode).toBe(409);
      const list = (await req('GET', base('vendors'), t)).json();
      expect(list.items.length).toBeGreaterThan(0);
    });
  });
});
