import {
  badRequest,
  conflict,
  MemoTypeSchema,
  notFound,
  OrgParamsSchema,
  OrgResourceParamsSchema,
  type MemoType,
} from '@finance-os/shared';
import { isValidMuxedAddress, validateMemo } from '@finance-os/stellar';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isForeignKeyViolation } from '../db-errors.js';
import { PageQuerySchema, pageArgs, pageOf, toPage } from '../lib/pagination.js';
import { iso } from '../lib/serialize.js';
import { membershipOf, requireOrgPermission } from '../plugins/auth.js';
import { bearerSecurity, DateTimeString, EmailSchema, errorResponses } from '../schemas/common.js';
import { DestinationInput } from '../schemas/stellar.js';

const VendorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string().nullable(),
  stellarAddress: z.string(),
  memoRequired: z.boolean(),
  memoType: MemoTypeSchema,
  memo: z.string().nullable(),
  createdAt: DateTimeString,
  updatedAt: DateTimeString,
});

type Row = {
  id: string;
  name: string;
  email: string | null;
  stellarAddress: string;
  memoRequired: boolean;
  memoType: MemoType;
  memo: string | null;
  createdAt: Date;
  updatedAt: Date;
};
const toDto = (v: Row) => ({
  id: v.id,
  name: v.name,
  email: v.email,
  stellarAddress: v.stellarAddress,
  memoRequired: v.memoRequired,
  memoType: v.memoType,
  memo: v.memo,
  createdAt: iso(v.createdAt),
  updatedAt: iso(v.updatedAt),
});

interface PayoutFields {
  stellarAddress: string;
  memoRequired: boolean;
  memoType: MemoType;
  memo: string | null;
}

/**
 * Returns an error message, or null if the payout details are consistent.
 * memoRequired is rejected for M... addresses: a muxed address already carries
 * the sub-account id, and a memo on top of it would be ambiguous to the exchange.
 */
function payoutError(v: PayoutFields): string | null {
  if (v.memoRequired) {
    if (isValidMuxedAddress(v.stellarAddress)) {
      return 'memoRequired cannot be used with a muxed (M...) address; the id is already in the address';
    }
    if (v.memoType === 'none') return 'memoRequired needs a memoType and memo';
  }
  if (v.memoType === 'none') return v.memo ? 'memo needs a memoType' : null;
  return validateMemo({ type: v.memoType, value: v.memo });
}

const NameInput = z.string().trim().min(1).max(200);
const MemoInput = z.string().max(64).nullable();
const BaseBody = z
  .object({
    name: NameInput,
    email: EmailSchema.nullish(),
    stellarAddress: DestinationInput,
    memoRequired: z.boolean().default(false),
    memoType: MemoTypeSchema.default('none'),
    memo: MemoInput.optional(),
  })
  .strict();
const CreateBody = BaseBody.superRefine((v, ctx) => {
  const error = payoutError({ ...v, memo: v.memo ?? null });
  if (error) ctx.addIssue({ code: 'custom', message: error, path: ['memo'] });
});
const UpdateBody = z
  .object({
    name: NameInput,
    email: EmailSchema.nullable(),
    stellarAddress: DestinationInput,
    memoRequired: z.boolean(),
    memoType: MemoTypeSchema,
    memo: MemoInput,
  })
  .partial()
  .strict();
const ListQuery = PageQuerySchema.extend({ q: z.string().trim().min(1).max(200).optional() });
const tags = ['vendors'];

export const vendorRoutes: FastifyPluginAsyncZod = async (app) => {
  const findOwned = async (organizationId: string, id: string) => {
    const vendor = await app.prisma.vendor.findFirst({ where: { id, organizationId } });
    if (!vendor) throw notFound('Vendor');
    return vendor;
  };

  app.get(
    '/orgs/:orgId/vendors',
    {
      preHandler: requireOrgPermission('org:read'),
      schema: {
        tags,
        summary: 'List vendors (newest first), optionally filtered by name',
        security: bearerSecurity,
        params: OrgParamsSchema,
        querystring: ListQuery,
        response: { 200: pageOf(VendorSchema), ...errorResponses(400, 401, 404) },
      },
    },
    async (req) => {
      const { organizationId } = membershipOf(req);
      const { q } = req.query;
      const rows = await app.prisma.vendor.findMany({
        where: { organizationId, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
        ...pageArgs(req.query),
      });
      return toPage(rows, req.query.limit, toDto);
    },
  );

  app.get(
    '/orgs/:orgId/vendors/:id',
    {
      preHandler: requireOrgPermission('org:read'),
      schema: {
        tags,
        summary: 'Get a vendor',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        response: { 200: VendorSchema, ...errorResponses(401, 404) },
      },
    },
    async (req) => toDto(await findOwned(membershipOf(req).organizationId, req.params.id)),
  );

  app.post(
    '/orgs/:orgId/vendors',
    {
      preHandler: requireOrgPermission('vendors:write'),
      schema: {
        tags,
        summary: 'Create a vendor with its payout address (and exchange memo, if required)',
        security: bearerSecurity,
        params: OrgParamsSchema,
        body: CreateBody,
        response: { 201: VendorSchema, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (req, reply) => {
      const { organizationId } = membershipOf(req);
      const b = req.body;
      const vendor = await app.prisma.vendor.create({
        data: {
          organizationId,
          name: b.name,
          email: b.email ?? null,
          stellarAddress: b.stellarAddress,
          memoRequired: b.memoRequired,
          memoType: b.memoType,
          memo: b.memoType === 'none' ? null : (b.memo ?? null),
        },
      });
      return reply.status(201).send(toDto(vendor));
    },
  );

  app.patch(
    '/orgs/:orgId/vendors/:id',
    {
      preHandler: requireOrgPermission('vendors:write'),
      schema: {
        tags,
        summary: 'Update a vendor',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        body: UpdateBody,
        response: { 200: VendorSchema, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (req) => {
      const { organizationId } = membershipOf(req);
      const existing = await findOwned(organizationId, req.params.id);
      const b = req.body;
      const memoType = b.memoType ?? existing.memoType;
      const merged: PayoutFields = {
        stellarAddress: b.stellarAddress ?? existing.stellarAddress,
        memoRequired: b.memoRequired ?? existing.memoRequired,
        memoType,
        // Switching to memoType none clears the memo.
        memo: memoType === 'none' && b.memo === undefined ? null : (b.memo ?? existing.memo),
      };
      const error = payoutError(merged);
      if (error) throw badRequest(error);
      const updated = await app.prisma.vendor.update({
        where: { id: existing.id },
        data: {
          ...merged,
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.email !== undefined ? { email: b.email } : {}),
        },
      });
      return toDto(updated);
    },
  );

  app.delete(
    '/orgs/:orgId/vendors/:id',
    {
      preHandler: requireOrgPermission('vendors:write'),
      schema: {
        tags,
        summary: 'Delete a vendor (only if no payment requests reference it)',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        response: { 204: z.null(), ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (req, reply) => {
      const { organizationId } = membershipOf(req);
      const existing = await findOwned(organizationId, req.params.id);
      await app.prisma.vendor.delete({ where: { id: existing.id } }).catch((err: unknown) => {
        if (isForeignKeyViolation(err)) throw conflict('Payment requests reference this vendor');
        throw err;
      });
      return reply.status(204).send(null);
    },
  );
};
