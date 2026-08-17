export function resolveIdempotencyKey({ headerValue, ticketNumber, paymentReference }) {
  return [headerValue, ticketNumber, paymentReference]
    .map((value) => String(value || '').trim())
    .find(Boolean) || null;
}

export function normalizeAtomicBookingResult(row) {
  if (!row) throw new Error('Atomic booking returned no ticket');

  return {
    idempotent: Boolean(row.was_idempotent),
    ticket: {
      id: row.ticket_id,
      ticket_number: row.ticket_number,
      trip_id: row.trip_id,
      passenger_id: row.passenger_id,
      booked_by: row.booked_by,
      seat_number: Number(row.seat_number),
      seat_class: row.seat_class,
      price_paid_usd: Number(row.price_paid_usd),
      payment_reference: row.payment_reference,
      payment_status: row.payment_status,
      payment_method: row.payment_method,
      qr_code_data: row.qr_code_data,
      status: row.status,
    },
  };
}

export function bookingErrorStatus(error) {
  if (error?.code === '23505') return 409;
  if (error?.code === '23514' || error?.code === '22023') return 400;
  if (error?.code === '42501') return 403;
  if (error?.code === 'P0002') return 404;
  if (error?.code === '55000') return 409;
  if (error?.code === 'PGRST202' || error?.code === '42883') return 503;
  return 500;
}
