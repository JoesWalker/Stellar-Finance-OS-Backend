import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authRoutes, type AuthRoutesOptions } from './auth.js';
import { clientRoutes } from './clients.js';
import { invoiceRoutes } from './invoices.js';
import { memberRoutes } from './members.js';
import { orgRoutes } from './orgs.js';
import { treasuryAccountRoutes } from './treasury-accounts.js';
import { vendorRoutes } from './vendors.js';

export type V1Options = AuthRoutesOptions;

/**
 * All business routes live under /v1 (README §8).
 * Route modules (auth, orgs, invoices, …) are registered here as they land.
 */
export const v1Routes: FastifyPluginAsyncZod<V1Options> = async (app, opts) => {
  await app.register(authRoutes, { sessionTtlMs: opts.sessionTtlMs });
  await app.register(orgRoutes);
  await app.register(memberRoutes);
  await app.register(treasuryAccountRoutes);
  await app.register(clientRoutes);
  await app.register(vendorRoutes);
  await app.register(invoiceRoutes);
};
