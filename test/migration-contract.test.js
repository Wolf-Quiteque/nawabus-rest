import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase-migration-atomic-booking-and-batched-availability.sql', import.meta.url);
const sql = await readFile(migrationUrl, 'utf8');

test('two concurrent attempts for one bus seat are serialized and conflict-checked', () => {
  const seatLock = /pg_advisory_xact_lock\([\s\S]*?v_bus_id::text \|\| ':' \|\| (?:NEW\.seat_number|p_seat_number)::text/;
  assert.match(sql, seatLock);
  assert.match(sql, /Seat already taken:[\s\S]+ERRCODE = '23505'/);
  assert.match(sql, /CREATE TRIGGER guard_seat_conflict_on_insert/);
});

test('lost response recovery uses a unique stable key before inserting', () => {
  assert.match(sql, /tickets_booker_idempotency_key/);
  const lookupAt = sql.indexOf('SELECT tk.* INTO v_existing');
  const insertAt = sql.indexOf('INSERT INTO public.tickets (', lookupAt);
  assert.ok(lookupAt > 0 && insertAt > lookupAt);
  assert.match(sql, /was_idempotent boolean/);
});

test('ticket and payment ledger are committed by one atomic database function', () => {
  const functionAt = sql.indexOf('CREATE OR REPLACE FUNCTION public.book_agent_ticket_atomic');
  const ticketAt = sql.indexOf('INSERT INTO public.tickets (', functionAt);
  const paymentAt = sql.indexOf('INSERT INTO public.payment_transactions (', ticketAt);
  const functionEnd = sql.indexOf('$function$;', paymentAt);
  assert.ok(functionAt > 0 && ticketAt > functionAt && paymentAt > ticketAt && functionEnd > paymentAt);
});

test('a payment-ledger failure is not swallowed after the ticket insert', () => {
  const functionAt = sql.indexOf('CREATE OR REPLACE FUNCTION public.book_agent_ticket_atomic');
  const functionEnd = sql.indexOf('$function$;', functionAt);
  const body = sql.slice(functionAt, functionEnd);
  const ticketAt = body.indexOf('INSERT INTO public.tickets (');
  const paymentAt = body.indexOf('INSERT INTO public.payment_transactions (', ticketAt);
  assert.ok(ticketAt > 0 && paymentAt > ticketAt);
  assert.doesNotMatch(body.slice(ticketAt), /EXCEPTION\s+WHEN/);
});

test('batched availability covers overlaps, unique seats, holds, statuses and co-pilot', () => {
  const functionAt = sql.indexOf('CREATE OR REPLACE FUNCTION public.get_trip_seat_availability');
  const functionEnd = sql.indexOf('$function$;', functionAt);
  const body = sql.slice(functionAt, functionEnd);
  assert.match(body, /sibling\.departure_time < req\.arrival_time/);
  assert.match(body, /req\.departure_time < sibling\.arrival_time/);
  assert.match(body, /UNION/);
  assert.match(body, /hold\.expires_at > now\(\)/);
  assert.match(body, /'active', 'pending', 'used'/);
  assert.match(body, /copilot_seat_number/);
  assert.match(body, /GREATEST\(req\.capacity - 1 - COUNT\(occupied\.seat_number\), 0\)/);
});

test('hot ticket and reference lookups have supporting indexes', () => {
  assert.match(sql, /idx_tickets_trip_status_seat/);
  assert.match(sql, /idx_tickets_payment_reference/);
  assert.match(sql, /idx_online_bookings_trip_expires_seat/);
  assert.match(sql, /idx_trips_bus_departure/);
  assert.match(sql, /idx_trips_status_departure/);
});
