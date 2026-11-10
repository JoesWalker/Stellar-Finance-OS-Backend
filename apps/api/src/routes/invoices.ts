import type { Prisma } from '@finance-os/db';
import {
  addAmounts,
  AmountSchema,
  conflict,
  IdSchema,
  InvoiceStatusSchema,
  invoiceStatusesThatCanBecome,
  isZeroAmount,
  multiplyAmounts,
  notFound,
  OrgParamsSchema,
  OrgResourceParamsSchema,
  QUEUES,
  randomToken,
  type InvoiceStatus,
} from '@finance-os/shared';
import { deriveMuxedAddress, invoiceMemo } from '@finance-os/stellar';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isUniqueViolation } from '../db-errors.js';
import { resolveAsset } from '../lib/assets.js';
import { pageArgs, pageOf, PageQuerySchema, toPage } from '../lib/pagination.js';
import { amount, dateOnly, iso, isoOrNull } from '../lib/serialize.js';
import { membershipOf, requireOrgPermission } from '../plugins/auth.js';
import { bearerSecurity, DateTimeString, errorResponses } from '../schemas/common.js';
import { amountDue, LineItemSchema, lineItemDto } from './invoice-dto.js';

const PositiveAmount = AmountSchema.refine((a) => !isZeroAmount(a), 'Must be greater than zero');

const LineItemInput = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: PositiveAmount,
  unitPrice: AmountSchema,
});
const LineItemsInput = z.array(LineItemInput).min(1).max(100);
const DueDateInput = z.iso.date();
const NotesInput = z.string().trim().max(5000);

const InvoiceSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  clientId: z.uuid(),
  treasuryAccountId: z.uuid(),
  status: InvoiceStatusSchema,
  assetCode: z.string(),
  assetIssuer: z.string().nullable(),
  amount: AmountSchema,
  amountPaid: AmountSchema,
  amountDue: AmountSchema,
  dueDate: z.iso.date(),
  notes: z.string().nullable(),
  paymentRefId: z.string().describe('uint64 as a decimal string'),
  muxedAddress: z.string().nullable(),
  memo: z.string().nullable(),
  publicToken: z.string(),
  sentAt: DateTimeString.nullable(),
  paidAt: DateTimeString.nullable(),
  voidedAt: DateTimeString.nullable(),
  createdAt: DateTimeString,
  updatedAt: DateTimeString,
});

const MatchSchema = z.object({
  id: z.uuid(),
  transactionId: z.uuid(),
  amount: AmountSchema,
  method: z.string(),
  confidence: z.string(),
  createdAt: DateTimeString,
});

const InvoiceDetailSchema = InvoiceSchema.extend({
  lineItems: z.array(LineItemSchema),
  matches: z.array(MatchSchema),
});

type InvoiceRow = Prisma.InvoiceGetPayload<object>;
type DetailRow = Prisma.InvoiceGetPayload<{ include: typeof detailInclude }>;

const detailInclude = {
  lineItems: { orderBy: { position: 'asc' } },
  matches: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.InvoiceInclude;

const toDto = (i: InvoiceRow) => ({
  id: i.id,
  number: i.number,
  clientId: i.clientId,
  treasuryAccountId: i.treasuryAccountId,
  status: i.status,
  assetCode: i.assetCode,
  assetIssuer: i.assetIssuer,
  amount: amount(i.amount),
  amountPaid: amount(i.amountPaid),
  amountDue: amountDue(i),
  dueDate: dateOnly(i.dueDate),
  notes: i.notes,
  paymentRefId: i.paymentRefId.toString(),
  muxedAddress: i.muxedAddress,
  memo: i.memo,
  publicToken: i.publicToken,
  sentAt: isoOrNull(i.sentAt),
  paidAt: isoOrNull(i.paidAt),
  voidedAt: isoOrNull(i.voidedAt),
  createdAt: iso(i.createdAt),
  updatedAt: iso(i.updatedAt),
});

const toDetailDto = (i: DetailRow) => ({
  ...toDto(i),
  lineItems: i.lineItems.map(lineItemDto),
  matches: i.matches.map((m) => ({
    id: m.id,
    transactionId: m.transactionId,
    amount: amount(m.amount),
    method: m.method,
    confidence: m.confidence.toFixed(4),
    createdAt: iso(m.createdAt),
  })),
});

/** Server-side totals: exact stroop math, the client never sends amounts. */
function priceLines(organizationId: string, items: z.infer<typeof LineItemsInput>) {
  const lines = items.map((l, position) => ({
    organizationId,
    position,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: multiplyAmounts(l.quantity, l.unitPrice),
  }));
  return { lines, total: addAmounts(...lines.map((l) => l.amount)) };
}

const parseDate = (d: string) => new Date(`${d}T00:00:00.000Z`);
const startOfUtcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const NUMBER_RETRIES = 10;
const tags = ['invoices'];

export const invoiceRoutes: FastifyPluginAsyncZod = async (app) => {
  const prisma = app.prisma;

  const loadDetail = async (organizationId: string, id: string) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id, organizationId },
      include: detailInclude,
    });
    if (!invoice) throw notFound('Invoice');
    return invoice;
  };

  /** Both must belong to the caller's org — 404 (not 400) so foreign ids can't be probed. */
  const assertOwnedRefs = async (
    organizationId: string,
    refs: { clientId?: string | undefined; treasuryAccountId?: string | undefined },
  ) => {
    const [client, treasury] = await Promise.all([
      refs.clientId
        ? prisma.client.findFirst({ where: { id: refs.clientId, organizationId } })
        : null,
      refs.treasuryAccountId
        ? prisma.treasuryAccount.findFirst({
            where: { id: refs.treasuryAccountId, organizationId },
          })
        : null,
    ]);
    if (refs.clientId && !client) throw notFound('Client');
    if (refs.treasuryAccountId && !treasury) throw notFound('Treasury account');
    return { client, treasury };
  };

  /**
   * Conditional transition: only rows still in an allowed `from` status move,
   * so two concurrent requests can't both transition. 404 vs 409 on a miss.
   */
  const transition = async (
    organizationId: string,
    id: string,
    to: InvoiceStatus,
    data: Prisma.InvoiceUpdateManyMutationInput,
    extraWhere: Prisma.InvoiceWhereInput = {},
  ) => {
    const from = invoiceStatusesThatCanBecome(to);
    const { count } = await prisma.invoice.updateMany({
      where: { id, organizationId, status: { in: from }, ...extraWhere },
      data: { ...data, status: to },
    });
    if (count === 0) {
      const current = await prisma.invoice.findFirst({ where: { id, organizationId } });
      if (!current) throw notFound('Invoice');
      if (from.includes(current.status)) {
        throw conflict('Invoice has matched payments and cannot be voided');
      }
      throw conflict(`Cannot move an invoice from ${current.status} to ${to}`);
    }
  };

  app.post(
    '/orgs/:orgId/invoices',
    {
      preHandler: requireOrgPermission('invoices:write'),
      schema: {
        tags,
        summary: 'Create a draft invoice with a unique muxed address and memo',
        security: bearerSecurity,
        params: OrgParamsSchema,
        body: z.object({
          clientId: IdSchema,
          treasuryAccountId: IdSchema,
          assetCode: z.string().trim().min(1).max(12),
          dueDate: DueDateInput,
          notes: NotesInput.optional(),
          lineItems: LineItemsInput,
        }),
        response: { 201: InvoiceDetailSchema, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (req, reply) => {
      const { organizationId } = membershipOf(req);
      const body = req.body;
      const { assetCode, assetIssuer } = resolveAsset(app.stellar, body.assetCode);
      const { treasury } = await assertOwnedRefs(organizationId, body);
      const { lines, total } = priceLines(organizationId, body.lineItems);
      const year = new Date().getUTCFullYear();
      const prefix = `INV-${year}-`;

      for (let attempt = 1; ; attempt++) {
        try {
          const id = await prisma.$transaction(async (tx) => {
            const taken = await tx.invoice.findMany({
              where: { organizationId, number: { startsWith: prefix } },
              select: { number: true },
            });
            const seq =
              taken.reduce((max, { number }) => {
                const n = /^INV-\d{4}-(\d+)$/.exec(number)?.[1];
                return n && n.length < 10 ? Math.max(max, parseInt(n, 10)) : max;
              }, 0) + 1;
            const created = await tx.invoice.create({
              data: {
                organizationId,
                clientId: body.clientId,
                treasuryAccountId: body.treasuryAccountId,
                number: `${prefix}${String(seq).padStart(4, '0')}`,
                assetCode,
                assetIssuer,
                amount: total,
                dueDate: parseDate(body.dueDate),
                notes: body.notes ?? null,
                publicToken: randomToken(),
                lineItems: { create: lines },
              },
            });
            // Both references derive from the DB-assigned paymentRefId.
            await tx.invoice.update({
              where: { id: created.id },
              data: {
                muxedAddress: deriveMuxedAddress(treasury!.stellarAddress, created.paymentRefId),
                memo: invoiceMemo(created.paymentRefId),
              },
            });
            return created.id;
          });
          return reply.status(201).send(toDetailDto(await loadDetail(organizationId, id)));
        } catch (err) {
          // Lost the race for the next number to a concurrent create: recompute and retry.
          if (isUniqueViolation(err) && attempt < NUMBER_RETRIES) continue;
          if (isUniqueViolation(err)) throw conflict('Could not allocate an invoice number');
          throw err;
        }
      }
    },
  );

  app.get(
    '/orgs/:orgId/invoices',
    {
      preHandler: requireOrgPermission('org:read'),
      schema: {
        tags,
        summary: 'List invoices (newest first, keyset-paginated)',
        security: bearerSecurity,
        params: OrgParamsSchema,
        querystring: PageQuerySchema.extend({
          status: InvoiceStatusSchema.optional(),
          clientId: IdSchema.optional(),
          overdue: z.stringbool().optional(),
        }),
        response: { 200: pageOf(InvoiceSchema), ...errorResponses(400, 401, 404) },
      },
    },
    async (req) => {
      const { organizationId } = membershipOf(req);
      const { status, clientId, overdue } = req.query;
      const today = startOfUtcDay(new Date());
      // Overdue = flagged by the worker, or past due and still unpaid before it ran.
      const overdueWhere: Prisma.InvoiceWhereInput = {
        OR: [
          { status: 'overdue' },
          { status: { in: ['sent', 'partially_paid'] }, dueDate: { lt: today } },
        ],
      };
      const rows = await prisma.invoice.findMany({
        where: {
          organizationId,
          ...(status ? { status } : {}),
          ...(clientId ? { clientId } : {}),
          ...(overdue === true ? overdueWhere : {}),
          ...(overdue === false ? { NOT: overdueWhere } : {}),
        },
        ...pageArgs(req.query),
      });
      return toPage(rows, req.query.limit, toDto);
    },
  );

  app.get(
    '/orgs/:orgId/invoices/:id',
    {
      preHandler: requireOrgPermission('org:read'),
      schema: {
        tags,
        summary: 'Get an invoice with line items and payment matches',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        response: { 200: InvoiceDetailSchema, ...errorResponses(401, 404) },
      },
    },
    async (req) => toDetailDto(await loadDetail(membershipOf(req).organizationId, req.params.id)),
  );

  app.patch(
    '/orgs/:orgId/invoices/:id',
    {
      preHandler: requireOrgPermission('invoices:write'),
      schema: {
        tags,
        summary: 'Edit a draft invoice (totals are recomputed from line items)',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        body: z.object({
          clientId: IdSchema.optional(),
          treasuryAccountId: IdSchema.optional(),
          assetCode: z.string().trim().min(1).max(12).optional(),
          dueDate: DueDateInput.optional(),
          notes: NotesInput.nullable().optional(),
          lineItems: LineItemsInput.optional(),
        }),
        response: { 200: InvoiceDetailSchema, ...errorResponses(400, 401, 403, 404, 409) },
      },
    },
    async (req) => {
      const { organizationId } = membershipOf(req);
      const { id } = req.params;
      const body = req.body;
      const asset = body.assetCode ? resolveAsset(app.stellar, body.assetCode) : null;
      const { treasury } = await assertOwnedRefs(organizationId, body);
      const priced = body.lineItems ? priceLines(organizationId, body.lineItems) : null;

      await prisma.$transaction(async (tx) => {
        const current = await tx.invoice.findFirst({ where: { id, organizationId } });
        if (!current) throw notFound('Invoice');
        const { count } = await tx.invoice.updateMany({
          where: { id, organizationId, status: 'draft' },
          data: {
            ...(body.clientId ? { clientId: body.clientId } : {}),
            ...(treasury
              ? {
                  treasuryAccountId: treasury.id,
                  muxedAddress: deriveMuxedAddress(treasury.stellarAddress, current.paymentRefId),
                }
              : {}),
            ...(asset ?? {}),
            ...(body.dueDate ? { dueDate: parseDate(body.dueDate) } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
            ...(priced ? { amount: priced.total } : {}),
          },
        });
        if (count === 0) throw conflict(`Only draft invoices can be edited (is ${current.status})`);
        if (priced) {
          await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id, organizationId } });
          await tx.invoiceLineItem.createMany({
            data: priced.lines.map((l) => ({ ...l, invoiceId: id })),
          });
        }
      });
      return toDetailDto(await loadDetail(organizationId, id));
    },
  );

  app.delete(
    '/orgs/:orgId/invoices/:id',
    {
      preHandler: requireOrgPermission('invoices:write'),
      schema: {
        tags,
        summary: 'Delete a draft invoice',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        response: { 204: z.null(), ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (req, reply) => {
      const { organizationId } = membershipOf(req);
      const { id } = req.params;
      const { count } = await prisma.invoice.deleteMany({
        where: { id, organizationId, status: 'draft' },
      });
      if (count === 0) {
        const current = await prisma.invoice.findFirst({ where: { id, organizationId } });
        if (!current) throw notFound('Invoice');
        throw conflict(`Only draft invoices can be deleted (is ${current.status})`);
      }
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/orgs/:orgId/invoices/:id/send',
    {
      preHandler: requireOrgPermission('invoices:write'),
      schema: {
        tags,
        summary: 'Mark a draft invoice as sent (emails the client when they have an address)',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        response: { 200: InvoiceDetailSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (req) => {
      const { organizationId } = membershipOf(req);
      const { id } = req.params;
      await transition(organizationId, id, 'sent', { sentAt: new Date() });
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { id, organizationId },
        include: { ...detailInclude, client: { select: { email: true } } },
      });
      if (invoice.client.email) {
        await app.jobs.enqueue(QUEUES.sendEmail, {
          kind: 'invoice_sent',
          organizationId,
          invoiceId: id,
        });
      }
      return toDetailDto(invoice);
    },
  );

  app.post(
    '/orgs/:orgId/invoices/:id/void',
    {
      preHandler: requireOrgPermission('invoices:write'),
      schema: {
        tags,
        summary: 'Void an invoice with no matched payments',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        response: { 200: InvoiceDetailSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (req) => {
      const { organizationId } = membershipOf(req);
      const { id } = req.params;
      await transition(
        organizationId,
        id,
        'void',
        { voidedAt: new Date() },
        { matches: { none: {} } },
      );
      return toDetailDto(await loadDetail(organizationId, id));
    },
  );
};
