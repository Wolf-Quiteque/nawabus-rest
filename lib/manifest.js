const LUANDA_OFFSET = '+01:00';

export const MANIFEST_AGENCIES = ['Kikolo', 'Gamek', 'Benguela', 'Todos'];

function canonicalAgency(value) {
  const wanted = String(value || '').trim().toLocaleLowerCase('pt-PT');
  return MANIFEST_AGENCIES.find(
    (agency) => agency.toLocaleLowerCase('pt-PT') === wanted,
  ) || null;
}

export function parseManifestQuery({ date, agency }) {
  const normalizedDate = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    throw new Error('date must use YYYY-MM-DD');
  }

  const startLocal = new Date(`${normalizedDate}T00:00:00${LUANDA_OFFSET}`);
  if (Number.isNaN(startLocal.getTime())) {
    throw new Error('date is invalid');
  }

  // Reject values such as 2026-02-31, which JavaScript would normalize.
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Luanda',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  if (formatter.format(startLocal) !== normalizedDate) {
    throw new Error('date is invalid');
  }

  const normalizedAgency = canonicalAgency(agency);
  if (!normalizedAgency) {
    throw new Error(`agency must be one of: ${MANIFEST_AGENCIES.join(', ')}`);
  }

  const endLocal = new Date(startLocal.getTime() + 24 * 60 * 60 * 1000);
  return {
    date: normalizedDate,
    agency: normalizedAgency,
    startIso: startLocal.toISOString(),
    endIso: endLocal.toISOString(),
  };
}

function one(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function firstCompanion(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function formatDeparture(value) {
  if (!value) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Luanda',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

export function buildManifestRows({ tickets, tripsById, profilesById }) {
  return (tickets || []).map((ticket) => {
    const trip = tripsById.get(ticket.trip_id);
    const route = one(trip?.route);
    const bus = one(trip?.bus);
    const companion = firstCompanion(ticket.companions);
    const profile = profilesById.get(ticket.passenger_id) || null;
    const profileName = [profile?.first_name, profile?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    const name = String(companion?.name || profileName || 'Passageiro').trim();
    const phone = String(companion?.phone || profile?.phone_number || '').trim();
    const price = Number(ticket.price_paid_usd || 0);
    const departureTime = trip?.departure_time || '';

    return {
      ticketId: ticket.id,
      boarding: ticket.ticket_number || '',
      nome: name,
      phone,
      passenger_phone: phone,
      origem: route?.origin_city || '',
      destino: route?.destination_city || '',
      dataHora: formatDeparture(departureTime),
      departure_iso: departureTime,
      departure_ts: departureTime ? new Date(departureTime).getTime() : 0,
      seat_number: Number(ticket.seat_number || 0),
      payment_method: ticket.payment_method || '',
      payment_status: ticket.payment_status || '',
      preco_value: Number.isFinite(price) ? Math.round(price) : 0,
      preco: `Kz ${Number.isFinite(price) ? Math.round(price) : 0}`,
      booking_source: ticket.booking_source || '',
      payment_reference: ticket.payment_reference || '',
      bus_plate: bus?.license_plate || '',
      ticket_status: ticket.status || '',
    };
  }).sort((left, right) =>
    String(left.departure_iso).localeCompare(String(right.departure_iso)) ||
    String(left.bus_plate).localeCompare(String(right.bus_plate)) ||
    String(left.origem).localeCompare(String(right.origem)) ||
    String(left.destino).localeCompare(String(right.destino)) ||
    left.seat_number - right.seat_number,
  );
}
