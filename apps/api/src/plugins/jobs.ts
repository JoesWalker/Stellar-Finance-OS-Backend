import type { QUEUES } from '@finance-os/shared';
import { type SendEmailJob } from '@finance-os/shared';
import type { FastifyInstance } from 'fastify';

/** Background jobs the API produces. main.ts wires a real queue; tests inject a recorder. */
export interface JobQueue {
  enqueue(queue: typeof QUEUES.sendEmail, job: SendEmailJob): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    jobs: JobQueue;
  }
}

/** Default when no queue is configured: log and drop. */
const loggingQueue = (app: FastifyInstance): JobQueue => ({
  async enqueue(queue, job) {
    app.log.info({ queue, job }, 'job queue not configured; dropping job');
  },
});

export function registerJobs(app: FastifyInstance, jobs?: JobQueue): void {
  app.decorate('jobs', jobs ?? loggingQueue(app));
}
