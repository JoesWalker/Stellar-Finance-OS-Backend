import { AmountSchema, InvoiceStatusSchema, notFound } from '@finance-os/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { dateOnly } from '../lib/serialize.js';
import { errorResponses } from '../schemas/common.js';
import { amountDue, LineItemSchema, lineItemDto } from './invoice-dto.js';

/**
 * Everything a payer needs and nothing else: no internal ids, no
 * organizationId/clientId, no client email.
 */
export const PublicInvoiceSchema = z.strictObject({
  organizationName: z.string(),
  number: z.string(),
  status: InvoiceStatusSchema.exclude(['draft']),
  asset: z.strictObject({ code: z.string(), issuer: z.string().nullable() }),
  amount: AmountSchema,
  amountPaid: AmountSchema,
  amountDue: AmountSchema,
  dueDate: z.iso.date(),
  muxedAddress: z.string().nullable(),
  memo: z.string().nullable(),
  lineItems: z.array(LineItemSchema),
});

export const publicInvoiceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/invoices/:publicToken',
    {
      schema: {
        tags: ['public'],
        summary: 'Payment page data for an invoice (no auth; the token is the capability)',
        params: z.object({ publicToken: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) }),
        response: { 200: PublicInvoiceSchema, ...errorResponses(400, 404) },
      },
    },
    async (req) => {
      const invoice = await app.prisma.invoice.findUnique({
        where: { publicToken: req.params.publicToken },
        include: {
          organization: { select: { name: true } },
          lineItems: { orderBy: { position: 'asc' } },
        },
      });
      // Drafts aren't published yet: same answer as an unknown token.
      if (!invoice || invoice.status === 'draft') throw notFound('Invoice');
      return {
        organizationName: invoice.organization.name,
        number: invoice.number,
        status: invoice.status,
        asset: { code: invoice.assetCode, issuer: invoice.assetIssuer },
        amount: invoice.amount.toFixed(7),
        amountPaid: invoice.amountPaid.toFixed(7),
        amountDue: amountDue(invoice),
        dueDate: dateOnly(invoice.dueDate),
        muxedAddress: invoice.muxedAddress,
        memo: invoice.memo,
        lineItems: invoice.lineItems.map(lineItemDto),
      };
    },
  );
};
