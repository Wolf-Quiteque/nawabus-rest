import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isCashLikePayment,
  normalizePaymentSplits,
  resolveBookingPaymentStatus,
} from '../lib/booking-payment.js';

test('cash-like counter payments are paid even when an old client sends pending', () => {
  for (const method of ['cash', 'tpa', 'tpa_dinheiro']) {
    assert.equal(isCashLikePayment(method), true);
    assert.equal(resolveBookingPaymentStatus(method, 'pending'), 'paid');
  }
});

test('reference payments retain their requested status', () => {
  assert.equal(resolveBookingPaymentStatus('referencia', 'pending'), 'pending');
  assert.equal(resolveBookingPaymentStatus('referencia', 'paid'), 'paid');
  assert.equal(resolveBookingPaymentStatus('referencia', 'unknown'), 'pending');
});

test('valid cash and TPA splits are normalized', () => {
  assert.deepEqual(
    normalizePaymentSplits([
      { method: 'tpa', amount: '6000' },
      { method: 'cash', amount: 4000 },
    ], 10000),
    [
      { method: 'tpa', amount: 6000 },
      { method: 'cash', amount: 4000 },
    ]
  );
});

test('invalid or incomplete split payments are rejected', () => {
  assert.throws(
    () => normalizePaymentSplits([{ method: 'tpa', amount: 5000 }], 10000),
    /must equal/
  );
  assert.throws(
    () => normalizePaymentSplits([{ method: 'card', amount: 10000 }], 10000),
    /cash\/TPA/
  );
});
