export const CASH_LIKE_PAYMENT_METHODS = Object.freeze([
  'cash',
  'tpa',
  'tpa_dinheiro',
]);

const VALID_PAYMENT_STATUSES = new Set(['pending', 'paid', 'failed', 'refunded']);

export function isCashLikePayment(method) {
  return CASH_LIKE_PAYMENT_METHODS.includes(method);
}

// Counter payments are already settled when the agent confirms the sale. Old
// Sunmi builds still send "pending", so the server is the source of truth and
// finalizes them during the original booking request.
export function resolveBookingPaymentStatus(paymentMethod, requestedStatus = 'pending') {
  if (isCashLikePayment(paymentMethod)) return 'paid';
  return VALID_PAYMENT_STATUSES.has(requestedStatus) ? requestedStatus : 'pending';
}

export function normalizePaymentSplits(splits, expectedAmount) {
  if (splits == null) return [];
  if (!Array.isArray(splits) || splits.length === 0) {
    throw new Error('Split payment must contain at least one part');
  }

  const normalized = splits.map((split) => {
    const method = split?.method;
    const amount = Number(split?.amount);
    if (!['cash', 'tpa'].includes(method) || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('Split payment parts must use cash/TPA and positive amounts');
    }
    return { method, amount };
  });

  const total = normalized.reduce((sum, split) => sum + split.amount, 0);
  if (Math.abs(total - Number(expectedAmount)) > 0.01) {
    throw new Error(`Split payment total must equal ${Number(expectedAmount).toFixed(2)}`);
  }

  return normalized;
}
