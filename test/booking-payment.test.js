import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isCashLikePayment,
  isSellableSeatNumber,
  isSupportedBookingPayment,
  normalizeSeatNumber,
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

test('booking payment methods are explicitly allow-listed', () => {
  for (const method of ['cash', 'tpa', 'tpa_dinheiro', 'referencia']) {
    assert.equal(isSupportedBookingPayment(method), true);
  }
  assert.equal(isSupportedBookingPayment('free'), false);
  assert.equal(isSupportedBookingPayment(undefined), false);
});

test('seat numbers must be integer passenger seats inside bus capacity', () => {
  assert.equal(normalizeSeatNumber('24'), 24);
  assert.equal(normalizeSeatNumber('2.5'), null);
  assert.equal(isSellableSeatNumber(1, 51), false);
  assert.equal(isSellableSeatNumber(2, 51), true);
  assert.equal(isSellableSeatNumber(51, 51), true);
  assert.equal(isSellableSeatNumber(52, 51), false);
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
