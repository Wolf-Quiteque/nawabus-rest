export const OCCUPYING_TICKET_STATUSES = Object.freeze(['active', 'pending', 'used']);

export function calculateSeatAvailability({
  capacity,
  ticketRows = [],
  holdRows = [],
  now = Date.now(),
  copilotSeatNumber = 1,
}) {
  const occupied = new Set();

  for (const row of ticketRows) {
    if (row?.status && !OCCUPYING_TICKET_STATUSES.includes(row.status)) continue;
    const seat = Number(row?.seat_number);
    if (Number.isInteger(seat) && seat !== copilotSeatNumber) occupied.add(seat);
  }

  for (const row of holdRows) {
    if (row?.expires_at && new Date(row.expires_at).getTime() <= now) continue;
    const seat = Number(row?.seat_number);
    if (Number.isInteger(seat) && seat !== copilotSeatNumber) occupied.add(seat);
  }

  const busCapacity = Math.max(Number(capacity) || 0, 0);
  const occupiedSeats = [...occupied].sort((a, b) => a - b);
  return {
    occupiedSeats,
    availableSeats: Math.max(busCapacity - 1 - occupiedSeats.length, 0),
  };
}

export function applyAvailabilityRows(trips, availabilityRows = []) {
  const availabilityByTrip = new Map(
    availabilityRows.map((row) => [
      row.trip_id,
      {
        availableSeats: Number(row.available_seats || 0),
        occupiedSeats: (row.occupied_seats || []).map(Number),
      },
    ])
  );

  return (trips || []).map((trip) => {
    const availability = availabilityByTrip.get(trip.id);
    return availability
      ? { ...trip, available_seats: availability.availableSeats }
      : trip;
  });
}

export async function getTripSeatAvailability(tripIds, client) {
  const uniqueTripIds = [...new Set((tripIds || []).filter(Boolean))];
  if (!uniqueTripIds.length) return [];

  const { data, error } = await client.rpc('get_trip_seat_availability', {
    p_trip_ids: uniqueTripIds,
  });
  if (error) throw error;
  return data || [];
}
