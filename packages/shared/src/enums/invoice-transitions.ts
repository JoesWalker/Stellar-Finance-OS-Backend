import type { InvoiceStatus } from './invoice-status.js';

/**
 * Allowed invoice status transitions. Routes and jobs move an invoice with a
 * conditional update whose `status IN (...)` comes from `invoiceStatusesThatCanBecome`,
 * so concurrent requests can't double-transition.
 */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ['sent', 'void'],
  sent: ['partially_paid', 'paid', 'overdue', 'void'],
  partially_paid: ['paid', 'overdue'],
  overdue: ['partially_paid', 'paid', 'void'],
  paid: [],
  void: [],
};

export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

/** Every status an invoice may move to `to` from. */
export function invoiceStatusesThatCanBecome(to: InvoiceStatus): InvoiceStatus[] {
  return (Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]).filter((from) =>
    canTransitionInvoice(from, to),
  );
}
