import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase-migration-atomic-booking-companions.sql', import.meta.url);
const sql = await readFile(migrationUrl, 'utf8');

test('one companion row is enforced for each ticket', () => {
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ticket_companions_ticket_id_key/);
  assert.match(sql, /ON public\.ticket_companions \(ticket_id\)/);
});

test('ticket, payment and companion are committed through one RPC transaction', () => {
  const wrapperAt = sql.indexOf('CREATE OR REPLACE FUNCTION public.book_agent_ticket_atomic_v2');
  const bookingAt = sql.indexOf('FROM public.book_agent_ticket_atomic(', wrapperAt);
  const companionAt = sql.indexOf('INSERT INTO public.ticket_companions', bookingAt);
  const wrapperEnd = sql.indexOf('$function$;', companionAt);
  assert.ok(wrapperAt >= 0 && bookingAt > wrapperAt && companionAt > bookingAt && wrapperEnd > companionAt);
  assert.doesNotMatch(sql.slice(wrapperAt, wrapperEnd), /EXCEPTION\s+WHEN/);
});

test('a retry cannot silently change the companion attached to a ticket', () => {
  assert.match(sql, /ON CONFLICT DO NOTHING/);
  assert.doesNotMatch(sql, /^\s*ON CONFLICT \(ticket_id\)/m);
  assert.match(sql, /Idempotency key already belongs to another companion/);
});

test('only the service role can execute the companion-aware booking RPC', () => {
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.book_agent_ticket_atomic_v2[\s\S]+FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.book_agent_ticket_atomic_v2[\s\S]+TO service_role/);
});
