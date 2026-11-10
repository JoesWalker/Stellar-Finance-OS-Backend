import { describe, expect, it } from 'vitest';
import { InvoiceStatusValues } from './invoice-status.js';
import {
  canTransitionInvoice,
  INVOICE_TRANSITIONS,
  invoiceStatusesThatCanBecome,
} from './invoice-transitions.js';

describe('invoice status transitions', () => {
  it('covers every status', () => {
    expect(Object.keys(INVOICE_TRANSITIONS).sort()).toEqual([...InvoiceStatusValues].sort());
  });

  it('only sends drafts', () => {
    expect(invoiceStatusesThatCanBecome('sent')).toEqual(['draft']);
  });

  it('voids from draft, sent or overdue only', () => {
    expect(invoiceStatusesThatCanBecome('void').sort()).toEqual(['draft', 'overdue', 'sent']);
  });

  it('treats paid and void as terminal', () => {
    for (const to of InvoiceStatusValues) {
      expect(canTransitionInvoice('paid', to)).toBe(false);
      expect(canTransitionInvoice('void', to)).toBe(false);
    }
  });

  it('rejects going back to draft', () => {
    for (const from of InvoiceStatusValues) expect(canTransitionInvoice(from, 'draft')).toBe(false);
  });
});
