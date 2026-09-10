import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifestRows, parseManifestQuery } from '../lib/manifest.js';

test('manifest query creates exact Luanda day boundaries', () => {
  assert.deepEqual(parseManifestQuery({ date: '2026-09-09', agency: 'gamek' }), {
    date: '2026-09-09',
    agency: 'Gamek',
    startIso: '2026-09-08T23:00:00.000Z',
    endIso: '2026-09-09T23:00:00.000Z',
  });
});

test('manifest query rejects impossible dates and unknown agencies', () => {
  assert.throws(() => parseManifestQuery({ date: '2026-02-31', agency: 'Gamek' }));
  assert.throws(() => parseManifestQuery({ date: '2026-09-09', agency: 'Unknown' }));
});

test('manifest rows prefer companion data and retain live trip details', () => {
  const tripsById = new Map([['trip-1', {
    departure_time: '2026-09-09T19:00:00.000Z',
    route: { origin_city: 'Gamek', destination_city: 'Benguela' },
    bus: { license_plate: 'LDA-50-07-AN' },
  }]]);
  const profilesById = new Map([['person-1', {
    first_name: 'Buyer', last_name: 'Name', phone_number: '900000000',
  }]]);
  const rows = buildManifestRows({
    tripsById,
    profilesById,
    tickets: [{
      id: 'ticket-1',
      trip_id: 'trip-1',
      passenger_id: 'person-1',
      ticket_number: 'NWA 2026 0001 AA00',
      seat_number: 12,
      price_paid_usd: 11000,
      payment_method: 'referencia',
      payment_status: 'paid',
      status: 'active',
      booking_source: 'website',
      companions: [{ name: 'Online Passenger', phone: '923000000' }],
    }],
  });

  assert.equal(rows[0].nome, 'Online Passenger');
  assert.equal(rows[0].origem, 'Gamek');
  assert.equal(rows[0].dataHora, '09/09/2026 20:00');
  assert.equal(rows[0].bus_plate, 'LDA-50-07-AN');
  assert.equal(rows[0].preco_value, 11000);
});
