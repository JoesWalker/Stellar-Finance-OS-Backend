import { conflict, notFound, OrgParamsSchema, OrgResourceParamsSchema } from '@finance-os/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isForeignKeyViolation } from '../db-errors.js';
import { PageQuerySchema, pageArgs, pageOf, toPage } from '../lib/pagination.js';
import { iso } from '../lib/serialize.js';
import { membershipOf, requireOrgPermission } from '../plugins/auth.js';
import { bearerSecurity, DateTimeString, EmailSchema, errorResponses } from '../schemas/common.js';

const ClientSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string().nullable(),
  /** Maintained by the matching engine; read-only through the API. */
  knownAddresses: z.array(z.string()),
  createdAt: DateTimeString,
  updatedAt: DateTimeString,
});

type Row = {
  id: string;
  name: string;
  email: string | null;
  knownAddresses: string[];
  createdAt: Date;
  updatedAt: Date;
};
const toDto = (c: Row) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  knownAddresses: c.knownAddresses,
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
});

const NameInput = z.string().trim().min(1).max(200);
const CreateBody = z.object({ name: NameInput, email: EmailSchema.nullish() }).strict();
const UpdateBody = CreateBody.partial();
const ListQuery = PageQuerySchema.extend({ q: z.string().trim().min(1).max(200).optional() });
const tags = ['clients'];

export const clientRoutes: FastifyPluginAsyncZod = async (app) => {
  const findOwned = async (organizationId: string, id: string) => {
    const client = await app.prisma.client.findFirst({ where: { id, organizationId } });
    if (!client) throw notFound('Client');
    return client;
  };

  app.get(
    '/orgs/:orgId/clients',
    {
      preHandler: requireOrgPermission('org:read'),
      schema: {
        tags,
        summary: 'List clients (newest first), optionally filtered by name',
        security: bearerSecurity,
        params: OrgParamsSchema,
        querystring: ListQuery,
        response: { 200: pageOf(ClientSchema), ...errorResponses(400, 401, 404) },
      },
    },
    async (req) => {
      const { organizationId } = membershipOf(req);
      const { q } = req.query;
      const rows = await app.prisma.client.findMany({
        where: { organizationId, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
        ...pageArgs(req.query),
      });
      return toPage(rows, req.query.limit, toDto);
    },
  );

  app.get(
    '/orgs/:orgId/clients/:id',
    {
      preHandler: requireOrgPermission('org:read'),
      schema: {
        tags,
        summary: 'Get a client',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        response: { 200: ClientSchema, ...errorResponses(401, 404) },
      },
    },
    async (req) => toDto(await findOwned(membershipOf(req).organizationId, req.params.id)),
  );

  app.post(
    '/orgs/:orgId/clients',
    {
      preHandler: requireOrgPermission('clients:write'),
      schema: {
        tags,
        summary: 'Create a client',
        security: bearerSecurity,
        params: OrgParamsSchema,
        body: CreateBody,
        response: { 201: ClientSchema, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (req, reply) => {
      const { organizationId } = membershipOf(req);
      const client = await app.prisma.client.create({
        data: { organizationId, name: req.body.name, email: req.body.email ?? null },
      });
      return reply.status(201).send(toDto(client));
    },
  );

  app.patch(
    '/orgs/:orgId/clients/:id',
    {
      preHandler: requireOrgPermission('clients:write'),
      schema: {
        tags,
        summary: 'Update a client',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        body: UpdateBody,
        response: { 200: ClientSchema, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (req) => {
      const { organizationId } = membershipOf(req);
      const existing = await findOwned(organizationId, req.params.id);
      const { name, email } = req.body;
      const updated = await app.prisma.client.update({
        where: { id: existing.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(email !== undefined ? { email } : {}),
        },
      });
      return toDto(updated);
    },
  );

  app.delete(
    '/orgs/:orgId/clients/:id',
    {
      preHandler: requireOrgPermission('clients:write'),
      schema: {
        tags,
        summary: 'Delete a client (only if no invoices reference it)',
        security: bearerSecurity,
        params: OrgResourceParamsSchema,
        response: { 204: z.null(), ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (req, reply) => {
      const { organizationId } = membershipOf(req);
      const existing = await findOwned(organizationId, req.params.id);
      await app.prisma.client.delete({ where: { id: existing.id } }).catch((err: unknown) => {
        if (isForeignKeyViolation(err)) throw conflict('Invoices reference this client');
        throw err;
      });
      return reply.status(204).send(null);
    },
  );
};
