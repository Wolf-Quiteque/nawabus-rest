import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAvailabilityRows,
  calculateSeatAvailability,
  getTripSeatAvailability,
} from '../lib/seat-availability.js';

test('overlapping trips share unique passenger seats', () => {
  const result = calculateSeatAvailability({
    capacity: 6,
    ticketRows: [
      { trip_id: 'segment-a', seat_number: 2, status: 'active' },
      { trip_id: 'segment-b', seat_number: 2, status: 'used' },
      { trip_id: 'segment-b', seat_number: 3, status: 'active' },
    ],
  });

  assert.deepEqual(result.occupiedSeats, [2, 3]);
  assert.equal(result.availableSeats, 3);
});

test('active holds occupy seats while expired holds do not', () => {
  const now = Date.parse('2026-08-17T12:00:00Z');
  const result = calculateSeatAvailability({
    capacity: 5,
    now,
    holdRows: [
      { seat_number: 2, expires_at: '2026-08-17T12:01:00Z' },
      { seat_number: 3, expires_at: '2026-08-17T11:59:59Z' },
    ],
  });

  assert.deepEqual(result.occupiedSeats, [2]);
  assert.equal(result.availableSeats, 3);
});

test('cancelled/refunded tickets do not occupy and co-pilot is excluded once', () => {
  const result = calculateSeatAvailability({
    capacity: 4,
    ticketRows: [
      { seat_number: 1, status: 'active' },
      { seat_number: 2, status: 'cancelled' },
      { seat_number: 3, status: 'refunded' },
      { seat_number: 4, status: 'used' },
    ],
  });

  assert.deepEqual(result.occupiedSeats, [4]);
  assert.equal(result.availableSeats, 2);
});

test('full bus calculation never becomes negative', () => {
  const result = calculateSeatAvailability({
    capacity: 4,
    ticketRows: [2, 3, 4, 5].map((seat_number) => ({ seat_number, status: 'active' })),
  });

  assert.equal(result.availableSeats, 0);
});

test('batched RPC rows replace cached availability by trip id', () => {
  const trips = [{ id: 'a', available_seats: 99 }, { id: 'b', available_seats: 99 }];
  assert.deepEqual(
    applyAvailabilityRows(trips, [
      { trip_id: 'a', available_seats: 4, occupied_seats: [2] },
      { trip_id: 'b', available_seats: 0, occupied_seats: [2, 3, 4, 5] },
    ]).map((trip) => trip.available_seats),
    [4, 0]
  );
});

test('1,000 trip availability checks use one deduplicated database RPC', async () => {
  const calls = [];
  const client = {
    async rpc(name, params) {
      calls.push({ name, params });
      return { data: [], error: null };
    },
  };
  const tripIds = Array.from({ length: 1000 }, (_, index) => `trip-${index}`);

  await getTripSeatAvailability([...tripIds, 'trip-0'], client);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'get_trip_seat_availability');
  assert.equal(calls[0].params.p_trip_ids.length, 1000);
});
