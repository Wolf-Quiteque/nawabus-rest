import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookingErrorStatus,
  normalizeAtomicBookingResult,
  resolveIdempotencyKey,
} from '../lib/booking-response.js';

const recoveredRow = {
  ticket_id: 'ticket-1',
  ticket_number: 'NWA 2026 0001 AB01',
  trip_id: 'trip-1',
  passenger_id: 'passenger-1',
  booked_by: 'agent-1',
  seat_number: 12,
  seat_class: 'economy',
  price_paid_usd: '10000.00',
  payment_reference: 'agent-stable-key',
  payment_status: 'paid',
  payment_method: 'cash',
  qr_code_data: 'TKT-trip-1-12',
  status: 'active',
  was_idempotent: true,
};

test('ticket number is a stable retry key when no header is supplied', () => {
  assert.equal(resolveIdempotencyKey({ ticketNumber: ' NWA 2026 0001 AB01 ' }), 'NWA 2026 0001 AB01');
});

test('explicit idempotency header takes precedence over ticket/payment references', () => {
  assert.equal(resolveIdempotencyKey({
    headerValue: 'request-123',
    ticketNumber: 'ticket-123',
    paymentReference: 'payment-123',
  }), 'request-123');
});

test('payment reference is a stable recovery key for clients without a ticket number', () => {
  assert.equal(resolveIdempotencyKey({ paymentReference: ' agent-1786977779047 ' }), 'agent-1786977779047');
});

test('lost-response retry returns the complete existing ticket shape for reprint', () => {
  const result = normalizeAtomicBookingResult(recoveredRow);
  assert.equal(result.idempotent, true);
  assert.deepEqual(result.ticket, {
    id: 'ticket-1',
    ticket_number: 'NWA 2026 0001 AB01',
    trip_id: 'trip-1',
    passenger_id: 'passenger-1',
    booked_by: 'agent-1',
    seat_number: 12,
    seat_class: 'economy',
    price_paid_usd: 10000,
    payment_reference: 'agent-stable-key',
    payment_status: 'paid',
    payment_method: 'cash',
    qr_code_data: 'TKT-trip-1-12',
    status: 'active',
  });
});

test('atomic seat conflicts are 409 while invalid seats are 400', () => {
  assert.equal(bookingErrorStatus({ code: '23505' }), 409);
  assert.equal(bookingErrorStatus({ code: '23514' }), 400);
});
