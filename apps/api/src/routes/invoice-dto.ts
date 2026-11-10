import { AmountSchema, compareAmounts, subtractAmounts } from '@finance-os/shared';
import { z } from 'zod';
import { amount, type DecimalLike } from '../lib/serialize.js';

export const LineItemSchema = z.object({
  description: z.string(),
  quantity: AmountSchema,
  unitPrice: AmountSchema,
  amount: AmountSchema,
});

export const lineItemDto = (l: {
  description: string;
  quantity: DecimalLike;
  unitPrice: DecimalLike;
  amount: DecimalLike;
}) => ({
  description: l.description,
  quantity: amount(l.quantity),
  unitPrice: amount(l.unitPrice),
  amount: amount(l.amount),
});

/** amount − amountPaid, floored at zero (an overpayment leaves nothing due). */
export function amountDue(i: { amount: DecimalLike; amountPaid: DecimalLike }): string {
  const total = amount(i.amount);
  const paid = amount(i.amountPaid);
  return compareAmounts(paid, total) >= 0 ? '0.0000000' : subtractAmounts(total, paid);
}
