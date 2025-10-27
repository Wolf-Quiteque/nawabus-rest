import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

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

const supabase = createClient(supabaseUrl, supabaseKey);

// Routes

// Routes

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
            name
          )
        )
      `)
      .eq('status', 'scheduled')
      .gt('available_seats', 0);

    // Apply filters
    if (origin && origin.trim()) {
      query = query.ilike('routes.origin_province', `%${origin.trim()}%`);
    }
    if (destination && destination.trim()) {
      query = query.ilike('routes.destination_province', `%${destination.trim()}%`);
    }
    if (date && date.trim()) {
      // Create date range for the specified date
      const searchDate = new Date(date.trim());
      const startOfDay = new Date(searchDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(searchDate);
      endOfDay.setHours(23, 59, 59, 999);

      query = query
        .gte('departure_time', startOfDay.toISOString())
        .lte('departure_time', endOfDay.toISOString());
    }
    if (seatClass && seatClass.trim()) {
      query = query.eq('seat_class', seatClass.trim());
    }

    // Sorting
    const sortOrder = order.toLowerCase() === 'desc' ? { ascending: false } : { ascending: true };
    query = query.order(sort, sortOrder);

    // Pagination
    const limitNum = parseInt(limit) || 50;
    const offsetNum = parseInt(offset) || 0;
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

    console.log(`Found ${trips?.length || 0} trips`);

    res.json({
      trips: trips || [],
      pagination: {
        offset: offsetNum,
        limit: limitNum,
        count: trips?.length || 0
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

    res.json({ trip });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// GET /api/trips/:tripId/booked_seats - Get booked seats for a trip
app.get('/api/trips/:tripId/booked_seats', async (req, res) => {
  try {
    const { tripId } = req.params;

    const { data: seats, error } = await supabase
      .from('tickets')
      .select('seat_number')
      .eq('trip_id', tripId)
      .in('status', ['active', 'used', 'pending']); // Include pending and used tickets as booked

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({
        error: 'Database error',
        details: error.message
      });
    }

    const bookedSeats = seats.map(s => s.seat_number);
    res.json({ booked_seats: bookedSeats });

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

// GET /api/provinces - Get distinct origin and destination provinces from routes
app.get('/api/provinces', async (req, res) => {
  try {
    // Get distinct origin provinces
    const { data: originProvinces, error: originError } = await supabase
      .from('routes')
      .select('origin_province')
      .eq('is_active', true);

    if (originError) {
      console.error('Origin provinces error:', originError);
      return res.status(500).json({
        error: 'Database error',
        details: originError.message
      });
    }

    // Get distinct destination provinces
    const { data: destinationProvinces, error: destinationError } = await supabase
      .from('routes')
      .select('destination_province')
      .eq('is_active', true);

    if (destinationError) {
      console.error('Destination provinces error:', destinationError);
      return res.status(500).json({
        error: 'Database error',
        details: destinationError.message
      });
    }

    // Extract unique provinces
    const origins = [...new Set(originProvinces.map(r => r.origin_province))].sort();
    const destinations = [...new Set(destinationProvinces.map(r => r.destination_province))].sort();

    res.json({
      origins: origins,
      destinations: destinations
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /api/booking - Book a trip
app.post('/api/booking', async (req, res) => {
  const client = supabase;
  try {
    const {
      tripId,
      passengerId,
      seatNumber,
      seatClass,
      paymentMethod,
      paymentReference,
      paymentStatus = 'pending' // Default to pending if not provided
    } = req.body;

    if (!tripId || !passengerId || !seatNumber || !paymentMethod) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Ensure paymentStatus is valid
    const validStatuses = ['pending', 'paid', 'failed', 'refunded'];
    const finalPaymentStatus = validStatuses.includes(paymentStatus) ? paymentStatus : 'pending';

    // Start transaction-like operation
    let ticketId = null;
    let paymentTransactionId = null;

    try {
      // Step 1: Check if seat is available
      const { data: existingTicket, error: ticketCheckError } = await client
        .from('tickets')
        .select('id')
        .eq('trip_id', tripId)
        .eq('seat_number', seatNumber)
        .in('status', ['active', 'pending']);

      if (ticketCheckError) throw ticketCheckError;

      if (existingTicket && existingTicket.length > 0) {
        return res.status(400).json({ error: 'Seat already taken' });
      }

      // Step 2: Get trip details for price
      const { data: trip, error: tripError } = await client
        .from('trips')
        .select('price_usd, available_seats, seat_class')
        .eq('id', tripId)
        .single();

      if (tripError || !trip) throw tripError || new Error('Trip not found');

      if (trip.available_seats <= 0) {
        return res.status(400).json({ error: 'No seats available' });
      }

      // Use seat_class from trip if not provided
      const finalSeatClass = seatClass || trip.seat_class;

      // Step 3: Create the ticket
      const { data: ticket, error: ticketError } = await client
        .from('tickets')
        .insert({
          trip_id: tripId,
          passenger_id: passengerId,
          booking_source: 'mobile_app', // Since this is for the separate app
          seat_class: finalSeatClass,
          seat_number: seatNumber,
          price_paid_usd: trip.price_usd,
          payment_status: finalPaymentStatus,
          payment_method: paymentMethod,
          payment_reference: paymentReference,
          qr_code_data: `TKT-${tripId}-${seatNumber}` // Simple QR data
        })
        .select('id, ticket_number')
        .single();

      if (ticketError) throw ticketError;
      ticketId = ticket.id;

      // Step 4: Create payment transaction record only for completed payments (cash)
      let paymentTransaction = null;
      if (paymentMethod === 'cash' && finalPaymentStatus === 'paid') {
        const { data: paymentTx, error: paymentError } = await client
          .from('payment_transactions')
          .insert({
            ticket_id: ticketId,
            amount_usd: trip.price_usd,
            currency: 'USD',
            payment_method: paymentMethod,
            status: 'completed',
            transaction_id: paymentReference || `txn-${Date.now()}`
          })
          .select('id')
          .single();

        if (paymentError) throw paymentError;
        paymentTransaction = paymentTx;
        paymentTransactionId = paymentTx.id;
      }

      // Step 5: Update available seats (this should be handled by trigger, but let's ensure it)
      await client.rpc('update_available_seats', {});

      res.status(201).json({
        success: true,
        ticket: {
          id: ticket.id,
          trip_id: tripId,
          seat_number: seatNumber,
          price_paid_usd: trip.price_usd,
          qr_code_data: `TKT-${tripId}-${seatNumber}`,
          ticket_number: ticket.ticket_number
        }
      });

    } catch (dbError) {
      console.error('Booking transaction error:', dbError);
      throw dbError;
    }

  } catch (error) {
    console.error('Booking error:', error);
    res.status(500).json({ error: 'Booking failed', details: error.message });
  }
});

// POST /api/payment - Handle payment (placeholder for future payment integration)kkk
app.post('/api/payment', async (req, res) => {
  try {
    const { amount, method, reference, ticketId } = req.body;

    // For now, just simulate payment processing
    // In a real implementation, you'd integrate with a payment processor

    // Update ticket payment status if ticketId provided
    if (ticketId) {
      const { error } = await supabase
        .from('tickets')
        .update({
          payment_status: 'paid',
          payment_method: method,
          payment_reference: reference
        })
        .eq('id', ticketId);

      if (error) throw error;
    }

    res.json({
      success: true,
      transaction_id: reference || `txn-${Date.now()}`,
      status: 'completed'
    });
  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

// PATCH /api/tickets/:ticketId/update-status - Update ticket payment status
app.patch('/api/tickets/:ticketId/update-status', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { payment_status } = req.body;

    if (!payment_status || !['paid', 'pending', 'failed', 'refunded'].includes(payment_status)) {
      return res.status(400).json({ error: 'Invalid payment status' });
    }

    const { data: ticket, error } = await supabase
      .from('tickets')
      .update({ payment_status })
      .eq('id', ticketId)
      .select('id, payment_status, ticket_number')
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

    // If marking as paid, also create payment transaction if it doesn't exist
    if (payment_status === 'paid') {
      const { data: ticketWithTrip } = await supabase
        .from('tickets')
        .select('price_paid_usd, trip_id')
        .eq('id', ticketId)
        .single();

      // Check if payment transaction already exists
      const { data: existingTx } = await supabase
        .from('payment_transactions')
        .select('id')
        .eq('ticket_id', ticketId)
        .single();

      if (!existingTx) {
        await supabase
          .from('payment_transactions')
          .insert({
            ticket_id: ticketId,
            amount_usd: ticketWithTrip.price_paid_usd,
            currency: 'USD',
            payment_method: 'cash', // Assuming cash for this update
            status: 'completed',
            transaction_id: `cash-${Date.now()}`
          });

        // Update trip available seats
        await supabase.rpc('update_available_seats', {});
      }
    }

    res.json({
      success: true,
      ticket: {
        id: ticket.id,
        payment_status: ticket.payment_status,
        ticket_number: ticket.ticket_number
      }
    });

  } catch (error) {
    console.error('Update ticket status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/users/get-or-create - Get or create a user profile
app.post('/api/users/get-or-create', async (req, res) => {
  try {
    let { name, phone } = req.body;
    phone = String(phone).trim(); // Ensure phone is string and trim whitespace

    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Name and phone are required' });
    }

    // 1. Search for existing profile by phone number
    const { data: existingProfile, error: profileError } = await supabase
      .from('profiles')
      .select('id, phone_number')
      .eq('phone_number', phone)
      .single();

    if (profileError && profileError.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('Error searching for profile:', profileError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    if (existingProfile) {
      console.log('Found existing profile for phone:', phone, 'userId:', existingProfile.id);
      return res.json({ success: true, userId: existingProfile.id });
    }

    console.log('No existing profile found for phone:', phone, 'creating new user');

    // 2. If not found, create a new user and profile
    const email = `${phone}@nawabus.com`;
    const password = 'luanda2025';
    const [firstName, ...lastNameParts] = name.split(' ');
    const lastName = lastNameParts.join(' ');

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: email,
      password: password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
          role: 'passenger',
          phone_number: phone
        }
      }
    });

    if (authError) {
      console.error('SignUp error for phone:', phone, 'email:', email, 'error:', authError.message);
      // If user already exists with this email/phone
      if (authError.message.includes('already registered') || authError.message.includes('already exists')) {
        return res.status(400).json({ success: false, error: 'User with this phone number already exists but is not properly linked. Please contact support.' });
      }
      return res.status(500).json({ success: false, error: 'Failed to create user account: ' + authError.message });
    }

    if (authData && authData.user) {
      // Ensure the profile has the phone number set
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ phone_number: phone })
        .eq('id', authData.user.id);

      if (updateError) {
        console.error('Error updating profile with phone:', updateError);
        // Continue anyway since user was created
      }

      console.log('Created new user for phone:', phone, 'userId:', authData.user.id);
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

// GET /api/health - Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
