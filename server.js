import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  isCashLikePayment,
  isSupportedBookingPayment,
  normalizeSeatNumber,
  normalizePaymentSplits,
  resolveBookingPaymentStatus,
} from './lib/booking-payment.js';
import {
  applyAvailabilityRows,
  calculateSeatAvailability,
  getTripSeatAvailability,
} from './lib/seat-availability.js';
import {
  bookingErrorStatus,
  normalizeAtomicBookingResult,
  resolveIdempotencyKey,
} from './lib/booking-response.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'placeholder-key';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});
const supabaseAdmin = supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : supabase;

/**
 * Seat 1 is permanently reserved for the co-pilot and can never be sold.
 * Mirrors public.copilot_seat_number() in the database, which rejects any
 * ticket written to this seat. Keep the two in sync.
 */
const COPILOT_SEAT_NUMBER = 1;

function isCopilotSeat(seatNumber) {
  return Number(seatNumber) === COPILOT_SEAT_NUMBER;
}

async function authenticateAgentRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'No access token provided', status: 401 };
  }

  const accessToken = authHeader.substring(7);
  const { data: { user }, error: verifyError } = await supabase.auth.getUser(accessToken);
  if (verifyError || !user) {
    return { error: 'Invalid or expired token', status: 401 };
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (profileError || !profile || !['agent', 'admin'].includes(profile.role)) {
    return { error: 'Unauthorized: Only agents can perform this operation', status: 403 };
  }

  return { user, profile };
}

async function legacySharedBusAvailability(trips, client) {
  if (!trips?.length) return trips || [];

  const siblingsByTrip = new Map();
  await Promise.all(trips.map(async (trip) => {
    const { data, error } = await client.rpc('get_overlapping_trip_ids', { p_trip_id: trip.id });
    if (error) throw error;
    siblingsByTrip.set(trip.id, data?.map((row) => row.id) || [trip.id]);
  }));

  const siblingIds = [...new Set([...siblingsByTrip.values()].flat())];
  const now = new Date().toISOString();
  const [{ data: tickets, error: ticketsError }, { data: holds, error: holdsError }] = await Promise.all([
    client.from('tickets').select('trip_id, seat_number, status').in('trip_id', siblingIds).in('status', ['active', 'pending', 'used']),
    client.from('online_bookings').select('trip_id, seat_number, expires_at').in('trip_id', siblingIds).gt('expires_at', now),
  ]);
  if (ticketsError || holdsError) throw ticketsError || holdsError;

  return trips.map((trip) => {
    const siblingTickets = [];
    const siblingHolds = [];
    for (const siblingId of siblingsByTrip.get(trip.id) || [trip.id]) {
      siblingTickets.push(...(tickets || []).filter((row) => row.trip_id === siblingId));
      siblingHolds.push(...(holds || []).filter((row) => row.trip_id === siblingId));
    }
    const bus = Array.isArray(trip.buses) ? trip.buses[0] : trip.buses;
    const availability = calculateSeatAvailability({
      capacity: bus?.capacity,
      ticketRows: siblingTickets,
      holdRows: siblingHolds,
      copilotSeatNumber: COPILOT_SEAT_NUMBER,
    });
    return { ...trip, available_seats: availability.availableSeats };
  });
}

// A bus can sell several overlapping route segments during one physical run.
// Resolve all requested trips in one set-based RPC instead of issuing one RPC
// per trip (the Sunmi sync requests up to 1,000 trips at a time).
async function applySharedBusAvailability(trips, client = supabaseAdmin) {
  if (!trips?.length) return trips || [];

  try {
    const availabilityRows = await getTripSeatAvailability(trips.map((trip) => trip.id), client);
    return applyAvailabilityRows(trips, availabilityRows);
  } catch (error) {
    // This fallback keeps deployment ordering safe if the API reaches Vercel
    // before the database migration. It is intentionally temporary/slow.
    if (['PGRST202', '42883'].includes(error?.code)) {
      console.warn('Batched availability RPC is not installed; using legacy availability queries');
      return legacySharedBusAvailability(trips, client);
    }
    throw error;
  }
}

function normalizePhoneNumber(phone) {
  const cleaned = String(phone || '').replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.length === 9 && cleaned.startsWith('9')) {
    return `244${cleaned}`;
  }
  return cleaned;
}

function phoneSearchVariants(phone) {
  const normalized = normalizePhoneNumber(phone);
  const cleaned = String(phone || '').replace(/\D/g, '');
  const variants = new Set([
    String(phone || '').trim(),
    cleaned,
    normalized
  ].filter(Boolean));

  if (normalized.startsWith('244') && normalized.length === 12) {
    variants.add(normalized.slice(3));
  }

  return [...variants];
}

function splitFullName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ')
  };
}

function createRequestAuthClient() {
  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// Routes

// Routes
'0«'
// POST /api/auth/login - User login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Use Supabase auth to sign in
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: password
    });

    if (authError) {
      console.error('Auth error:', authError);
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Get additional user profile information
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', authData.user.id)
      .single();

    if (profileError) {
      console.error('Profile fetch error:', profileError);
      // Don't fail login if profile fetch fails, just return limited info
    }

    res.json({
      success: true,
      user: {
        id: authData.user.id,
        email: authData.user.email,
        role: profile?.role || 'passenger',
        first_name: profile?.first_name || '',
        last_name: profile?.last_name || '',
        phone_number: profile?.phone_number || null
      },
      session: {
        access_token: authData.session?.access_token,
        refresh_token: authData.session?.refresh_token,
        expires_at: authData.session?.expires_at
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during login'
    });
  }
});

// POST /api/auth/refresh - Refresh access token using refresh_token
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        success: false,
        error: 'refresh_token is required'
      });
    }

    const { data, error } = await supabase.auth.refreshSession({ refresh_token });

    if (error) {
      console.error('Token refresh error:', error);
      return res.status(401).json({
        success: false,
        error: 'Failed to refresh token: ' + error.message
      });
    }

    res.json({
      success: true,
      session: {
        access_token: data.session?.access_token,
        refresh_token: data.session?.refresh_token,
        expires_at: data.session?.expires_at
      }
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during token refresh'
    });
  }
});

// POST /api/auth/register - User registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, role = 'passenger' } = req.body;

    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, first name, and last name are required'
      });
    }

    const allowedRoles = ['passenger', 'agent', 'driver'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid role. Must be passenger, agent, or driver'
      });
    }

    // Create user account
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: email.trim(),
      password: password,
      options: {
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          role: role
        }
      }
    });

    if (authError) {
      console.error('Registration error:', authError);
      return res.status(400).json({
        success: false,
        error: authError.message
      });
    }

    res.status(201).json({
      success: true,
      user: {
        id: authData.user?.id,
        email: authData.user?.email,
        role: role,
        first_name: firstName.trim(),
        last_name: lastName.trim()
      },
      message: 'User registered successfully. Please check your email to confirm your account.'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during registration'
    });
  }
});

// POST /api/auth/logout - User logout
app.post('/api/auth/logout', async (req, res) => {
  try {
    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error('Logout error:', error);
      return res.status(500).json({
        success: false,
        error: 'Error during logout'
      });
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during logout'
    });
  }
});

// GET /api/auth/me - Get current user profile
app.get('/api/auth/me', async (req, res) => {
  try {
    // Get the access token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'No access token provided'
      });
    }

    const accessToken = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify the session with Supabase
    const { data: { user }, error: verifyError } = await supabase.auth.getUser(accessToken);

    if (verifyError || !user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    // Get user profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('Profile fetch error:', profileError);
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: profile?.role || 'passenger',
        first_name: profile?.first_name || '',
        last_name: profile?.last_name || '',
        phone_number: profile?.phone_number || null,
        date_of_birth: profile?.date_of_birth || null,
        national_id: profile?.national_id || null
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// GET /api/trips - Search for trips
app.get('/api/trips', async (req, res) => {
  try {
    const {
      origin,
      destination,
      date,
      class: seatClass,
      sort = 'departure_time',
      order = 'asc',
      limit = '50',
      offset = '0'
    } = req.query;

    console.log('Request URL:', req.url);
    console.log('Search params:', { origin, destination, date, seatClass, sort, order, limit, offset });

    let query = supabase
      .from('trips')
      .select(`
        id,
        departure_time,
        arrival_time,
        price_usd,
        available_seats,
        seat_class,
        status,
        routes!inner (
          origin_city,
          destination_city,
          origin_province,
          destination_province,
          distance_km,
          estimated_duration_hours
        ),
        buses!inner (
          make,
          model,
          license_plate,
          capacity,
          amenities,
          companies!inner (
            name,
            logo_url
          )
        )
      `)
      .eq('status', 'scheduled')
      // Only surface trips whose bus is still active. When an admin sets
      // buses.is_active = false, the bus should no longer be purchasable.
      .eq('buses.is_active', true);

    // Apply filters. Terminals now sell by CITY (Kikolo, Gamek, Benguela...)
    // so match either the city or the province — older clients that still
    // send province names keep working.
    if (origin && origin.trim()) {
      const o = origin.trim();
      query = query.or(
        `origin_province.ilike.%${o}%,origin_city.ilike.%${o}%`,
        { foreignTable: 'routes' }
      );
    }
    if (destination && destination.trim()) {
      const d = destination.trim();
      query = query.or(
        `destination_province.ilike.%${d}%,destination_city.ilike.%${d}%`,
        { foreignTable: 'routes' }
      );
    }
    if (date && date.trim()) {
      const localDate = date.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
        return res.status(400).json({ error: 'Date must use YYYY-MM-DD format' });
      }
      // Vercel runs in UTC, while terminals search by the Angola calendar day.
      const startOfDay = new Date(`${localDate}T00:00:00.000+01:00`);
      const endOfDay = new Date(`${localDate}T23:59:59.999+01:00`);
      if (Number.isNaN(startOfDay.getTime()) || Number.isNaN(endOfDay.getTime())) {
        return res.status(400).json({ error: 'Invalid date' });
      }

      query = query
        .gte('departure_time', startOfDay.toISOString())
        .lte('departure_time', endOfDay.toISOString());
    } else {
      // The terminal's periodic sync intentionally omits a date. Do not send
      // stale rows that were never moved out of "scheduled" after departure.
      query = query.gte('departure_time', new Date().toISOString());
    }
    if (seatClass && seatClass.trim()) {
      query = query.eq('seat_class', seatClass.trim());
    }

    // Sorting
    const allowedSortFields = new Set(['departure_time', 'arrival_time', 'price_usd', 'seat_class']);
    const sortField = allowedSortFields.has(sort) ? sort : 'departure_time';
    const sortOrder = order.toLowerCase() === 'desc' ? { ascending: false } : { ascending: true };
    query = query.order(sortField, sortOrder);

    // Pagination
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);
    query = query.range(offsetNum, offsetNum + limitNum - 1);

    const { data: trips, error, count } = await query;

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({
        error: 'Database error',
        details: error.message,
        code: error.code
      });
    }

    const tripsWithSharedAvailability = await applySharedBusAvailability(trips || []);
    const sellableTrips = tripsWithSharedAvailability.filter((trip) => trip.available_seats > 0);

    console.log(`Found ${sellableTrips.length} sellable trips`);

    res.json({
      trips: sellableTrips,
      pagination: {
        offset: offsetNum,
        limit: limitNum,
        count: sellableTrips.length
      },
      filters: {
        origin: origin || null,
        destination: destination || null,
        date: date || null,
        class: seatClass || null
      }
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// GET /api/trips/:tripId - Get specific trip details
app.get('/api/trips/:tripId', async (req, res) => {
  try {
    const { tripId } = req.params;

    const { data: trip, error } = await supabase
      .from('trips')
      .select(`
        id,
        departure_time,
        arrival_time,
        price_usd,
        available_seats,
        seat_class,
        status,
        bus_id,
        driver_id,
        routes!inner (
          origin_city,
          destination_city,
          origin_province,
          destination_province,
          distance_km,
          estimated_duration_hours,
          base_price_usd
        ),
        buses!inner (
          make,
          model,
          license_plate,
          capacity,
          amenities,
          is_active,
          companies!inner (
            name,
            license_number,
            contact_email,
            contact_phone
          )
        )
      `)
      .eq('id', tripId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Trip not found' });
      }
      console.error('Supabase error:', error);
      return res.status(500).json({
        error: 'Database error',
        details: error.message
      });
    }

    // Hide trips whose bus has been deactivated (is_active = false).
    const tripBus = Array.isArray(trip.buses) ? trip.buses[0] : trip.buses;
    if (tripBus && tripBus.is_active === false) {
      return res.status(404).json({ error: 'Trip not available' });
    }

    const [tripWithSharedAvailability] = await applySharedBusAvailability([trip]);
    res.json({ trip: tripWithSharedAvailability });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// GET /api/trips/:tripId/booked_seats - Get booked seats for a trip (including sibling trips)
app.get('/api/trips/:tripId/booked_seats', async (req, res) => {
  try {
    const { tripId } = req.params;

    let availabilityRows;
    try {
      availabilityRows = await getTripSeatAvailability([tripId], supabaseAdmin);
    } catch (error) {
      if (!['PGRST202', '42883'].includes(error?.code)) throw error;

      const siblingIds = await getSiblingTripIds(tripId);
      const now = new Date().toISOString();
      const [{ data: tickets, error: ticketsError }, { data: holds, error: holdsError }] = await Promise.all([
        supabaseAdmin
          .from('tickets')
          .select('seat_number, status')
          .in('trip_id', siblingIds)
          .in('status', ['active', 'pending', 'used']),
        supabaseAdmin
          .from('online_bookings')
          .select('seat_number, expires_at')
          .in('trip_id', siblingIds)
          .gt('expires_at', now),
      ]);
      if (ticketsError || holdsError) throw ticketsError || holdsError;
      const fallback = calculateSeatAvailability({
        capacity: 0,
        ticketRows: tickets || [],
        holdRows: holds || [],
        copilotSeatNumber: COPILOT_SEAT_NUMBER,
      });
      availabilityRows = [{ trip_id: tripId, occupied_seats: fallback.occupiedSeats }];
    }
    if (!availabilityRows.length) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    // The co-pilot seat is never sellable, so it is reported as booked to
    // every client (the Sunmi app picks its seat from whatever is left).
    // Active online holds are included too, matching booking validation.
    const bookedSeats = (availabilityRows[0].occupied_seats || []).map(Number);
    if (!bookedSeats.some(isCopilotSeat)) {
      bookedSeats.push(COPILOT_SEAT_NUMBER);
    }

    res.json({
      booked_seats: bookedSeats,
      reserved_seats: [COPILOT_SEAT_NUMBER]
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// GET /api/routes - Get available routes
app.get('/api/routes', async (req, res) => {
  try {
    const { active = 'true' } = req.query;

    let query = supabase
      .from('routes')
      .select('*')
      .order('origin_city', { ascending: true });

    if (active === 'true') {
      query = query.eq('is_active', true);
    }

    const { data: routes, error } = await query;

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({
        error: 'Database error',
        details: error.message
      });
    }

    res.json({ routes: routes || [] });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Helper: get all trip IDs that share the same bus and have an overlapping
// [departure_time, arrival_time] window (sibling trips). Backed by the
// get_overlapping_trip_ids() Postgres function so every booking surface
// (this API, agent-web-app, agent-pwa) resolves siblings identically.
async function getSiblingTripIds(tripId) {
  const { data: siblings, error } = await supabase
    .rpc('get_overlapping_trip_ids', { p_trip_id: tripId });

  if (error || !siblings) return [tripId];
  return siblings.map(s => s.id);
}

// Helper function to generate reference number
function generateReferenceCode() {
  const ts = Date.now().toString();
  const tail = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return ts.slice(-8) + tail;
}

// POST /api/booking - Atomically create or recover an agent booking
app.post('/api/booking', async (req, res) => {
  try {
    const auth = await authenticateAgentRequest(req);
    if (auth.error) {
      return res.status(auth.status).json({ success: false, error: auth.error });
    }

    const {
      tripId,
      passengerId,
      seatNumber,
      seatClass,
      paymentMethod,
      paymentReference,
      paymentStatus = 'pending',
      ticketNumber = null,
      splits = null,
    } = req.body;

    if (!tripId || !passengerId || seatNumber == null || !paymentMethod) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const normalizedSeatNumber = normalizeSeatNumber(seatNumber);
    if (normalizedSeatNumber === null) {
      return res.status(400).json({ error: 'Seat number must be an integer' });
    }

    if (!isSupportedBookingPayment(paymentMethod)) {
      return res.status(400).json({ error: 'Unsupported payment method' });
    }

    if (isCopilotSeat(normalizedSeatNumber)) {
      return res.status(400).json({
        error: 'Seat reserved for the co-pilot',
        details: 'Seat ' + COPILOT_SEAT_NUMBER + ' is always reserved for the co-pilot and cannot be sold.',
      });
    }

    const normalizedTicketNumber = String(ticketNumber || '').trim() || null;
    const normalizedPaymentReference = String(paymentReference || '').trim() || null;
    const idempotencyKey = resolveIdempotencyKey({
      headerValue: req.get('Idempotency-Key'),
      ticketNumber: normalizedTicketNumber,
      paymentReference: normalizedPaymentReference,
    });
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'A stable Idempotency-Key, ticketNumber, or paymentReference is required',
      });
    }
    if (idempotencyKey.length > 200) {
      return res.status(400).json({ error: 'Idempotency key must not exceed 200 characters' });
    }

    let normalizedSplits = [];
    if (paymentMethod === 'tpa_dinheiro' && splits != null) {
      if (!Array.isArray(splits) || !splits.length) {
        return res.status(400).json({ error: 'Split payment must contain at least one part' });
      }
      normalizedSplits = splits.map((split) => ({
        method: split?.method,
        amount: Number(split?.amount),
      }));
      if (normalizedSplits.some((split) =>
        !['cash', 'tpa'].includes(split.method) ||
        !Number.isFinite(split.amount) ||
        split.amount <= 0
      )) {
        return res.status(400).json({
          error: 'Split payment parts must use cash/TPA and positive amounts',
        });
      }
    }

    // Counter payments commit as paid with their ledger row in the same
    // database transaction. A reference payment remains in its requested state.
    const finalPaymentStatus = resolveBookingPaymentStatus(paymentMethod, paymentStatus);
    const finalReference = normalizedPaymentReference || (
      isCashLikePayment(paymentMethod)
        ? 'agent-' + idempotencyKey
        : generateReferenceCode()
    );

    const { data, error } = await supabaseAdmin.rpc('book_agent_ticket_atomic', {
      p_trip_id: tripId,
      p_passenger_id: passengerId,
      p_booked_by: auth.user.id,
      p_seat_number: normalizedSeatNumber,
      p_payment_method: paymentMethod,
      p_payment_status: finalPaymentStatus,
      p_idempotency_key: idempotencyKey,
      p_seat_class: seatClass || null,
      p_payment_reference: finalReference,
      p_ticket_number: normalizedTicketNumber,
      p_splits: normalizedSplits,
    });
    if (error) throw error;

    const atomicRow = Array.isArray(data) ? data[0] : data;
    const result = normalizeAtomicBookingResult(atomicRow);
    return res.status(result.idempotent ? 200 : 201).json({
      success: true,
      idempotent: result.idempotent,
      recovered: result.idempotent,
      ticket: result.ticket,
    });
  } catch (error) {
    console.error('Booking error:', error);
    const status = bookingErrorStatus(error);
    const message = error?.code === '23505' && /seat/i.test(error.message || '')
      ? 'Seat already taken'
      : 'Booking failed';
    return res.status(status).json({ error: message, details: error.message });
  }
});

// PATCH /api/tickets/:ticketId/mark-paid - Legacy compatibility for older Sunmi builds.
app.patch('/api/tickets/:ticketId/mark-paid', async (req, res) => {
  const client = supabase;
  try {
    // Verify authentication
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'No access token provided'
      });
    }

    const accessToken = authHeader.substring(7);
    const { data: { user }, error: verifyError } = await supabase.auth.getUser(accessToken);

    if (verifyError || !user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    // Check agent role
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || (!['agent', 'admin'].includes(profile.role))) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized: Only agents can update ticket status'
      });
    }

    const { ticketId } = req.params;
    const { paymentMethod, splits } = req.body;

    if (!ticketId) {
      return res.status(400).json({ error: 'Missing ticketId' });
    }

    // Fetch the ticket to get price and trip_id
    const { data: ticket, error: ticketError } = await client
      .from('tickets')
      .select('id, price_paid_usd, trip_id, payment_status, payment_method, booked_by')
      .eq('id', ticketId)
      .single();

    if (ticketError || !ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    if (profile.role !== 'admin' && ticket.booked_by !== user.id) {
      return res.status(403).json({ error: 'Agents can only finalize their own ticket sales' });
    }

    const { data: existingTransactions, error: existingError } = await client
      .from('payment_transactions')
      .select('id')
      .eq('ticket_id', ticketId)
      .eq('status', 'completed');
    if (existingError) throw existingError;

    // New bookings are finalized by POST /api/booking. Older Sunmi builds still
    // call this endpoint afterward, so treat an already-paid ticket with a
    // completed ledger row as an idempotent success.
    if (ticket.payment_status === 'paid') {
      if (existingTransactions?.length) {
        return res.json({
          success: true,
          message: 'Ticket already marked as paid',
          ticket_id: ticketId,
          already_paid: true,
        });
      }
      return res.status(409).json({
        error: 'Ticket is paid but its payment transaction is missing',
        current_status: ticket.payment_status,
      });
    }

    if (ticket.payment_status !== 'pending') {
      return res.status(400).json({
        error: `Ticket already has status: ${ticket.payment_status}`,
        current_status: ticket.payment_status
      });
    }

    // For split payments (TPA & Dinheiro), `splits` is an array like
    // [{method:'tpa', amount:6000}, {method:'cash', amount:4000}] and one
    // transaction row is created per part so reports show exactly what money
    // went through the TPA vs cash. Parts must sum exactly to the ticket
    // price so the ledger never disagrees with the sale amount — validated
    // BEFORE the ticket is marked paid.
    let validSplits = [];
    if (splits != null) {
      try {
        validSplits = normalizePaymentSplits(splits, ticket.price_paid_usd);
      } catch (splitError) {
        return res.status(400).json({ error: splitError.message });
      }
    }

    const transactionSeed = randomUUID();
    const txRows = validSplits.length > 0
      ? validSplits.map((s, i) => ({
          ticket_id: ticketId,
          amount_usd: Number(s.amount),
          currency: 'USD',
          payment_method: s.method,
          status: 'completed',
          transaction_id: `agent-${transactionSeed}-${i}`
        }))
      : [{
          ticket_id: ticketId,
          amount_usd: ticket.price_paid_usd,
          currency: 'USD',
          payment_method: paymentMethod || 'cash',
          status: 'completed',
          transaction_id: `agent-${transactionSeed}`
        }];

    let insertedTransactionIds = [];
    if (!existingTransactions?.length) {
      const { data: insertedTransactions, error: paymentError } = await client
        .from('payment_transactions')
        .insert(txRows)
        .select('id');

      if (paymentError) {
        // Leave the ticket pending: the app must not print/board it as paid.
        throw paymentError;
      }
      insertedTransactionIds = (insertedTransactions || []).map((row) => row.id);
    }

    // Publish paid only after the ledger exists. If this final update fails,
    // remove the rows created by this request so a retry remains clean.
    const { error: updateError } = await client
      .from('tickets')
      .update({ payment_status: 'paid' })
      .eq('id', ticketId);

    if (updateError) {
      if (insertedTransactionIds.length) {
        const { error: cleanupError } = await client
          .from('payment_transactions')
          .delete()
          .in('id', insertedTransactionIds);
        if (cleanupError) {
          console.error('Failed to clean payment rows after ticket update failure:', cleanupError);
        }
      }
      throw updateError;
    }

    res.json({
      success: true,
      message: 'Ticket marked as paid',
      ticket_id: ticketId
    });

  } catch (error) {
    console.error('Mark paid error:', error);
    res.status(500).json({ error: 'Failed to mark ticket as paid', details: error.message });
  }
});

// POST /api/payment - Removed unsafe legacy simulator. It accepted arbitrary
// ticket IDs and could mark them paid without authentication or a ledger row.
app.post('/api/payment', (_req, res) => {
  res.status(410).json({
    error: 'This payment endpoint is retired. Use /api/booking or the authenticated mark-paid endpoint.',
  });
});

// GET /api/tickets/by-reference/:ref - Look up a ticket by payment_reference
app.get('/api/tickets/by-reference/:ref', async (req, res) => {
  try {
    const { ref } = req.params;

    const { data: tickets, error } = await supabase
      .from('tickets')
      .select('id, ticket_number, trip_id, passenger_id, booked_by, seat_number, seat_class, price_paid_usd, payment_reference, payment_status, payment_method, qr_code_data, status')
      .eq('payment_reference', ref)
      .limit(2);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    if (!tickets?.length) {
      return res.json({ success: false, error: 'Not found' });
    }
    if (tickets.length > 1) {
      return res.status(409).json({
        success: false,
        error: 'Payment reference matches multiple tickets; use the booking idempotency key',
        matches: tickets.map((ticket) => ticket.id),
      });
    }

    res.json({ success: true, ticket: tickets[0] });
  } catch (error) {
    console.error('Ticket by reference error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PATCH /api/tickets/:ticketId/update-status - Update ticket payment status
app.patch('/api/tickets/:ticketId/update-status', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { payment_status } = req.body;

    const auth = await authenticateAgentRequest(req);
    if (auth.error) {
      return res.status(auth.status).json({ success: false, error: auth.error });
    }

    // The Sunmi legacy client only uses this endpoint to finalize a counter
    // payment. Other status transitions belong to the authenticated admin flow.
    if (payment_status !== 'paid') {
      return res.status(400).json({ error: 'This endpoint only supports marking a ticket as paid' });
    }

    const { data: ticket, error } = await supabaseAdmin
      .from('tickets')
      .select('id, booked_by, payment_status, payment_method, price_paid_usd, ticket_number')
      .eq('id', ticketId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      console.error('Supabase error:', error);
      return res.status(500).json({
        error: 'Database error',
        details: error.message
      });
    }

    if (auth.profile.role !== 'admin' && ticket.booked_by !== auth.user.id) {
      return res.status(403).json({ error: 'Agents can only finalize their own ticket sales' });
    }

    const { data: existingTransactions, error: existingError } = await supabaseAdmin
      .from('payment_transactions')
      .select('id')
      .eq('ticket_id', ticketId)
      .eq('status', 'completed');
    if (existingError) throw existingError;

    if (ticket.payment_status === 'paid') {
      if (existingTransactions?.length) {
        return res.json({
          success: true,
          already_paid: true,
          ticket: {
            id: ticket.id,
            payment_status: ticket.payment_status,
            ticket_number: ticket.ticket_number,
          },
        });
      }

      return res.status(409).json({
        error: 'Ticket is paid but its payment transaction is missing',
        current_status: ticket.payment_status,
      });
    }

    if (ticket.payment_status !== 'pending') {
      return res.status(409).json({
        error: `Ticket already has status: ${ticket.payment_status}`,
        current_status: ticket.payment_status,
      });
    }

    const { data: insertedTransaction, error: paymentError } = await supabaseAdmin
      .from('payment_transactions')
      .insert({
        ticket_id: ticketId,
        amount_usd: ticket.price_paid_usd,
        currency: 'USD',
        payment_method: ticket.payment_method || 'cash',
        status: 'completed',
        transaction_id: `legacy-${randomUUID()}`,
      })
      .select('id')
      .single();
    if (paymentError) throw paymentError;

    const { data: updatedRows, error: updateError } = await supabaseAdmin
      .from('tickets')
      .update({ payment_status: 'paid' })
      .eq('id', ticketId)
      .eq('payment_status', 'pending')
      .select('id');

    if (updateError || !updatedRows?.length) {
      await supabaseAdmin
        .from('payment_transactions')
        .delete()
        .eq('id', insertedTransaction.id);

      if (updateError) throw updateError;
      return res.status(409).json({ error: 'Ticket payment status changed concurrently; retry the request' });
    }

    res.json({
      success: true,
      ticket: {
        id: ticket.id,
        payment_status: 'paid',
        ticket_number: ticket.ticket_number
      }
    });

  } catch (error) {
    console.error('Update ticket status error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/users/get-or-create - Get or create a user profile
app.post('/api/users/get-or-create', async (req, res) => {
  try {
    let { name, phone } = req.body;
    name = String(name || '').trim();
    const normalizedPhone = normalizePhoneNumber(phone);
    const phoneVariants = phoneSearchVariants(phone);

    if (!name || !normalizedPhone) {
      return res.status(400).json({ success: false, error: 'Name and phone are required' });
    }

    if (normalizedPhone.length < 9) {
      return res.status(400).json({ success: false, error: 'Invalid phone number' });
    }

    // 1. Search for an existing passenger by normalized phone and common legacy variants.
    const { data: existingProfiles, error: profileError } = await supabase
      .from('profiles')
      .select('id, phone_number, role')
      .in('phone_number', phoneVariants)
      .order('created_at', { ascending: false })
      .limit(1);

    if (profileError) {
      console.error('Error searching for profile:', profileError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    const existingProfile = existingProfiles?.[0];
    if (existingProfile) {
      if (existingProfile.phone_number !== normalizedPhone) {
        const { error: normalizeError } = await supabaseAdmin
          .from('profiles')
          .update({ phone_number: normalizedPhone })
          .eq('id', existingProfile.id);

        if (normalizeError) {
          console.warn('Could not normalize existing profile phone:', normalizeError);
        }
      }

      console.log('Found existing profile for phone:', normalizedPhone, 'userId:', existingProfile.id);
      return res.json({ success: true, userId: existingProfile.id });
    }

    console.log('No existing profile found for phone:', normalizedPhone, 'creating new user');

    // 2. If not found, create a new user and profile
    const email = `${normalizedPhone}@nawabus.com`;
    const password = 'luanda2025';
    const { firstName, lastName } = splitFullName(name);
    const authClient = createRequestAuthClient();

    let authData = null;
    let authError = null;

    if (supabaseServiceRoleKey) {
      const result = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          first_name: firstName,
          last_name: lastName,
          role: 'passenger',
          phone_number: normalizedPhone
        }
      });
      authData = result.data;
      authError = result.error;
    } else {
      const result = await authClient.auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name: firstName,
            last_name: lastName,
            role: 'passenger',
            phone_number: normalizedPhone
          }
        }
      });
      authData = result.data;
      authError = result.error;
    }

    if (authError) {
      console.error('User creation error for phone:', normalizedPhone, 'email:', email, 'error:', authError.message);

      if (authError.message.includes('already registered') || authError.message.includes('already exists') || authError.message.includes('already been registered')) {
        const { data: signInData, error: signInError } = await authClient.auth.signInWithPassword({
          email,
          password
        });

        if (!signInError && signInData?.user?.id) {
          const profileClient = supabaseServiceRoleKey ? supabaseAdmin : authClient;
          const { error: upsertError } = await profileClient
            .from('profiles')
            .upsert({
              id: signInData.user.id,
              role: 'passenger',
              first_name: firstName,
              last_name: lastName,
              phone_number: normalizedPhone
            }, { onConflict: 'id' });

          if (upsertError) {
            console.warn('Could not repair profile for existing auth user:', upsertError);
          }

          return res.json({ success: true, userId: signInData.user.id });
        }

        const { data: retryProfiles, error: retryProfileError } = await supabase
          .from('profiles')
          .select('id, phone_number')
          .in('phone_number', phoneVariants)
          .limit(1);

        if (!retryProfileError && retryProfiles?.[0]?.id) {
          return res.json({ success: true, userId: retryProfiles[0].id });
        }
      }

      return res.status(500).json({ success: false, error: 'Failed to get or create passenger account' });
    }

    if (authData && authData.user) {
      // Ensure the profile has the phone number set
      const { error: upsertError } = await supabaseAdmin
        .from('profiles')
        .upsert({
          id: authData.user.id,
          role: 'passenger',
          first_name: firstName,
          last_name: lastName,
          phone_number: normalizedPhone
        }, { onConflict: 'id' });

      if (upsertError) {
        console.error('Error upserting profile with phone:', upsertError);
        // Continue anyway since user was created
      }

      console.log('Created new user for phone:', normalizedPhone, 'userId:', authData.user.id);
      res.status(201).json({ success: true, userId: authData.user.id });
    } else {
      console.error('SignUp succeeded but no user data returned');
      res.status(500).json({ success: false, error: 'User creation failed unexpectedly' });
    }

  } catch (error) {
    console.error('Get or create user error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/validate-coupon?code=XXXX - Validate a coupon code
app.get('/api/validate-coupon', async (req, res) => {
  try {
    const code = (req.query.code || '').trim().toUpperCase();

    if (!code) {
      return res.status(400).json({ valid: false, message: 'Código é obrigatório' });
    }

    const { data, error } = await supabase
      .from('coupons')
      .select('id, code, discount_percentage, is_active')
      .eq('code', code)
      .single();

    if (error || !data) {
      return res.json({ valid: false, message: 'Cupom inválido ou inexistente' });
    }

    if (!data.is_active) {
      return res.json({ valid: false, message: 'Este cupom está inactivo' });
    }

    return res.json({ valid: true, discount_percentage: data.discount_percentage, code: data.code });
  } catch (error) {
    console.error('Error validating coupon:', error);
    res.status(500).json({ valid: false, message: 'Erro ao validar cupom' });
  }
});

// POST /api/mobile/booking - Create booking for mobile app with payment reference
app.post('/api/mobile/booking', async (req, res) => {
  try {
    const {
      outboundTrip,
      returnTrip,
      outboundSeats,
      returnSeats,
      passengerId,
      passengerName,
      passengerEmail,
      paymentMethod,
      couponCode
    } = req.body;

    // Validation
    if (!outboundTrip || !outboundSeats || outboundSeats.length === 0 || !passengerId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if ([...(outboundSeats || []), ...(returnSeats || [])].some(isCopilotSeat)) {
      return res.status(400).json({
        error: 'Seat reserved for the co-pilot',
        details: `Seat ${COPILOT_SEAT_NUMBER} is always reserved for the co-pilot and cannot be sold.`
      });
    }

    // Validate coupon if provided
    let discountFactor = 1;
    if (couponCode) {
      const normalizedCode = couponCode.trim().toUpperCase();
      const { data: coupon } = await supabase
        .from('coupons')
        .select('discount_percentage, is_active')
        .eq('code', normalizedCode)
        .single();
      if (coupon && coupon.is_active) {
        discountFactor = 1 - coupon.discount_percentage / 100;
      }
    }

    const ticketIds = [];
    let totalAmount = 0;

    // Create outbound tickets
    for (const seatNumber of outboundSeats) {
      const { data: ticket, error } = await supabase
        .from('tickets')
        .insert({
          trip_id: outboundTrip.id,
          passenger_id: passengerId,
          booked_by: passengerId,
          booking_source: 'mobile_app',
          seat_class: outboundTrip.seat_class || 'economy',
          seat_number: seatNumber,
          price_paid_usd: parseFloat((outboundTrip.price_usd * discountFactor).toFixed(2)),
          payment_status: 'pending',
          payment_method: paymentMethod || 'referencia',
          qr_code_data: `TKT-${outboundTrip.id}-${seatNumber}`
        })
        .select('id, ticket_number, price_paid_usd')
        .single();

      if (error) throw error;
      ticketIds.push(ticket.id);
      totalAmount += ticket.price_paid_usd;
    }

    // Create return tickets if round trip
    if (returnTrip && returnSeats && returnSeats.length > 0) {
      for (const seatNumber of returnSeats) {
        const { data: ticket, error } = await supabase
          .from('tickets')
          .insert({
            trip_id: returnTrip.id,
            passenger_id: passengerId,
            booked_by: passengerId,
            booking_source: 'mobile_app',
            seat_class: returnTrip.seat_class || 'economy',
            seat_number: seatNumber,
            price_paid_usd: parseFloat((returnTrip.price_usd * discountFactor).toFixed(2)),
            payment_status: 'pending',
            payment_method: paymentMethod || 'referencia',
            qr_code_data: `TKT-${returnTrip.id}-${seatNumber}`
          })
          .select('id, ticket_number, price_paid_usd')
          .single();

        if (error) throw error;
        ticketIds.push(ticket.id);
        totalAmount += ticket.price_paid_usd;
      }
    }

    // Generate payment reference for MULTICAIXA
    let paymentReference = null;
    if (paymentMethod === 'referencia') {
      try {
        const paymentApiUrl = process.env.PAYMENT_API_URL || 'https://payments-nawabus.vercel.app/api/create-payment';

        const paymentResponse = await fetch(paymentApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ticket_id: ticketIds[0], // Primary ticket
            amount: totalAmount,
            passenger_name: passengerName,
            passenger_email: passengerEmail,
          }),
        });

        if (paymentResponse.ok) {
          const paymentData = await paymentResponse.json();
          paymentReference = paymentData.reference_number || paymentData.reference;

          // Update all tickets with the payment reference
          for (const ticketId of ticketIds) {
            await supabase
              .from('tickets')
              .update({ payment_reference: paymentReference })
              .eq('id', ticketId);
          }
        }
      } catch (paymentError) {
        console.error('Payment reference generation failed:', paymentError);
        // Continue without reference - tickets are already created
      }
    }

    res.status(201).json({
      success: true,
      ticketIds,
      totalAmount,
      paymentReference,
      entity: '1219', // MULTICAIXA entity
      message: 'Booking created successfully'
    });

  } catch (error) {
    console.error('Mobile booking error:', error);
    res.status(500).json({ error: 'Booking failed', details: error.message });
  }
});

// GET /api/health - Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
