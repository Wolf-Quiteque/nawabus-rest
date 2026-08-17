-- Nawabus REST API production hardening (2026-08-17)
--
-- Apply this migration before deploying the matching server.js change.
-- It replaces per-trip overlap RPC calls with one set-based availability call,
-- adds the missing hot-path indexes, and commits a ticket plus its counter
-- payment ledger atomically behind a stable idempotency key.

CREATE INDEX IF NOT EXISTS idx_tickets_trip_status_seat
  ON public.tickets (trip_id, status, seat_number);

CREATE INDEX IF NOT EXISTS idx_tickets_payment_reference
  ON public.tickets (payment_reference)
  WHERE payment_reference IS NOT NULL AND payment_reference <> '';

CREATE INDEX IF NOT EXISTS idx_online_bookings_trip_expires_seat
  ON public.online_bookings (trip_id, expires_at, seat_number);

CREATE INDEX IF NOT EXISTS idx_trips_status_departure
  ON public.trips (status, departure_time);

CREATE INDEX IF NOT EXISTS idx_trips_bus_departure
  ON public.trips (bus_id, departure_time);

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_booker_idempotency_key
  ON public.tickets (booked_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- One call calculates every requested trip. UNION deliberately de-duplicates a
-- seat that appears in more than one overlapping segment or in both a ticket
-- and an online hold. Seat 1 is reserved separately and is never subtracted
-- twice. Expired holds and cancelled/refunded tickets do not occupy a seat.
CREATE OR REPLACE FUNCTION public.get_trip_seat_availability(p_trip_ids uuid[])
RETURNS TABLE (
  trip_id uuid,
  available_seats integer,
  occupied_seats integer[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH requested AS (
    SELECT DISTINCT
      tr.id AS trip_id,
      tr.bus_id,
      tr.departure_time,
      tr.arrival_time,
      b.capacity
    FROM public.trips tr
    JOIN public.buses b ON b.id = tr.bus_id
    WHERE tr.id = ANY(COALESCE(p_trip_ids, ARRAY[]::uuid[]))
  ),
  occupied AS (
    SELECT req.trip_id, tk.seat_number
    FROM requested req
    JOIN public.trips sibling
      ON sibling.bus_id = req.bus_id
     AND sibling.departure_time < req.arrival_time
     AND req.departure_time < sibling.arrival_time
    JOIN public.tickets tk ON tk.trip_id = sibling.id
    WHERE tk.status IN ('active', 'pending', 'used')
      AND tk.seat_number <> public.copilot_seat_number()

    UNION

    SELECT req.trip_id, hold.seat_number
    FROM requested req
    JOIN public.trips sibling
      ON sibling.bus_id = req.bus_id
     AND sibling.departure_time < req.arrival_time
     AND req.departure_time < sibling.arrival_time
    JOIN public.online_bookings hold ON hold.trip_id = sibling.id
    WHERE hold.expires_at > now()
      AND hold.seat_number <> public.copilot_seat_number()
  )
  SELECT
    req.trip_id,
    GREATEST(req.capacity - 1 - COUNT(occupied.seat_number), 0)::integer,
    COALESCE(
      array_agg(occupied.seat_number ORDER BY occupied.seat_number)
        FILTER (WHERE occupied.seat_number IS NOT NULL),
      ARRAY[]::integer[]
    )
  FROM requested req
  LEFT JOIN occupied ON occupied.trip_id = req.trip_id
  GROUP BY req.trip_id, req.capacity;
$function$;

REVOKE ALL ON FUNCTION public.get_trip_seat_availability(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_trip_seat_availability(uuid[])
  TO service_role;

-- Avoid recalculating availability for payment/reference-only updates. Those
-- updates previously fired the expensive overlap scan despite not changing a
-- seat. The cached value counts unique passenger seats; live GET endpoints add
-- unexpired holds through get_trip_seat_availability().
CREATE OR REPLACE FUNCTION public.update_available_seats()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_trip_id uuid := COALESCE(NEW.trip_id, OLD.trip_id);
BEGIN
  UPDATE public.trips target
  SET available_seats = GREATEST(
        (b.capacity - 1) - (
          SELECT COUNT(DISTINCT tk.seat_number)
          FROM public.tickets tk
          JOIN public.trips src ON src.id = tk.trip_id
          WHERE src.bus_id = target.bus_id
            AND src.departure_time < target.arrival_time
            AND target.departure_time < src.arrival_time
            AND tk.status IN ('active', 'pending', 'used')
            AND tk.seat_number <> public.copilot_seat_number()
        ), 0)
  FROM public.buses b
  WHERE b.id = target.bus_id
    AND target.id IN (
      SELECT overlap.id FROM public.get_overlapping_trip_ids(v_trip_id) overlap
    );

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS update_available_seats ON public.tickets;
DROP TRIGGER IF EXISTS update_available_seats_on_insert_delete ON public.tickets;
DROP TRIGGER IF EXISTS update_available_seats_on_seat_change ON public.tickets;

CREATE TRIGGER update_available_seats_on_insert_delete
AFTER INSERT OR DELETE ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.update_available_seats();

CREATE TRIGGER update_available_seats_on_seat_change
AFTER UPDATE OF trip_id, seat_number, status ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.update_available_seats();

-- One overlap-aware guard is sufficient. The older minute-based trigger did a
-- second ticket scan and did not protect segments with different start times.
DROP TRIGGER IF EXISTS prevent_duplicate_active_bus_seat_trigger ON public.tickets;

CREATE OR REPLACE FUNCTION public.guard_seat_conflict()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_bus_id uuid;
  v_departure_time timestamptz;
  v_arrival_time timestamptz;
BEGIN
  IF NEW.seat_number IS NULL OR NEW.status NOT IN ('active', 'pending', 'used') THEN
    RETURN NEW;
  END IF;

  IF NEW.seat_number = public.copilot_seat_number()
     AND (
       TG_OP = 'INSERT'
       OR OLD.seat_number IS DISTINCT FROM NEW.seat_number
       OR OLD.status NOT IN ('active', 'pending', 'used')
     )
  THEN
    RAISE EXCEPTION 'Seat % is reserved for the co-pilot and cannot be sold', NEW.seat_number
      USING ERRCODE = '23514';
  END IF;

  SELECT tr.bus_id, tr.departure_time, tr.arrival_time
    INTO v_bus_id, v_departure_time, v_arrival_time
  FROM public.trips tr
  WHERE tr.id = NEW.trip_id;

  IF v_bus_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The hold function uses the same bus lock, so a hold and ticket cannot both
  -- win a race for overlapping segments of the same physical bus.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_bus_id::text || ':' || NEW.seat_number::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.tickets tk
    JOIN public.trips sibling ON sibling.id = tk.trip_id
    WHERE sibling.bus_id = v_bus_id
      AND sibling.departure_time < v_arrival_time
      AND v_departure_time < sibling.arrival_time
      AND tk.seat_number = NEW.seat_number
      AND tk.status IN ('active', 'pending', 'used')
      AND tk.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'Seat already taken: seat % conflicts with an overlapping trip on this bus', NEW.seat_number
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_seat_conflict ON public.tickets;
DROP TRIGGER IF EXISTS guard_seat_conflict_on_insert ON public.tickets;
DROP TRIGGER IF EXISTS guard_seat_conflict_on_seat_change ON public.tickets;

CREATE TRIGGER guard_seat_conflict_on_insert
BEFORE INSERT ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.guard_seat_conflict();

CREATE TRIGGER guard_seat_conflict_on_seat_change
BEFORE UPDATE OF trip_id, seat_number, status ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.guard_seat_conflict();

CREATE OR REPLACE FUNCTION public.create_seat_hold(
  p_trip_id uuid,
  p_passenger_id uuid,
  p_seat_number integer,
  p_hold_duration_minutes integer DEFAULT 15
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_hold_id uuid;
  v_bus_id uuid;
  v_departure_time timestamptz;
  v_arrival_time timestamptz;
  v_capacity integer;
BEGIN
  SELECT tr.bus_id, tr.departure_time, tr.arrival_time, b.capacity
    INTO v_bus_id, v_departure_time, v_arrival_time, v_capacity
  FROM public.trips tr
  JOIN public.buses b ON b.id = tr.bus_id
  WHERE tr.id = p_trip_id;

  IF v_bus_id IS NULL THEN
    RAISE EXCEPTION 'Trip not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_seat_number < 2 OR p_seat_number > v_capacity THEN
    RAISE EXCEPTION 'Seat is outside the sellable passenger range'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_bus_id::text || ':' || p_seat_number::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.tickets tk
    JOIN public.trips sibling ON sibling.id = tk.trip_id
    WHERE sibling.bus_id = v_bus_id
      AND sibling.departure_time < v_arrival_time
      AND v_departure_time < sibling.arrival_time
      AND tk.seat_number = p_seat_number
      AND tk.status IN ('active', 'pending', 'used')
  ) OR EXISTS (
    SELECT 1
    FROM public.online_bookings hold
    JOIN public.trips sibling ON sibling.id = hold.trip_id
    WHERE sibling.bus_id = v_bus_id
      AND sibling.departure_time < v_arrival_time
      AND v_departure_time < sibling.arrival_time
      AND hold.seat_number = p_seat_number
      AND hold.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Seat not available' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.online_bookings (trip_id, passenger_id, seat_number, expires_at)
  VALUES (
    p_trip_id,
    p_passenger_id,
    p_seat_number,
    now() + make_interval(mins => p_hold_duration_minutes)
  )
  RETURNING id INTO v_hold_id;

  RETURN v_hold_id;
END;
$function$;

-- Ticket insert + completed counter ledger are in the same PostgreSQL
-- transaction. If any later statement fails, PostgreSQL rolls the insert back.
-- If the HTTP response is lost after commit, the same booker/idempotency key
-- returns the committed ticket without re-running seat validation.
CREATE OR REPLACE FUNCTION public.book_agent_ticket_atomic(
  p_trip_id uuid,
  p_passenger_id uuid,
  p_booked_by uuid,
  p_seat_number integer,
  p_payment_method text,
  p_payment_status text,
  p_idempotency_key text,
  p_seat_class text DEFAULT NULL,
  p_payment_reference text DEFAULT NULL,
  p_ticket_number text DEFAULT NULL,
  p_splits jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE (
  ticket_id uuid,
  ticket_number text,
  trip_id uuid,
  passenger_id uuid,
  booked_by uuid,
  seat_number integer,
  seat_class text,
  price_paid_usd numeric,
  payment_reference text,
  payment_status text,
  payment_method text,
  qr_code_data text,
  status text,
  was_idempotent boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing public.tickets%ROWTYPE;
  v_ticket public.tickets%ROWTYPE;
  v_bus_id uuid;
  v_departure_time timestamptz;
  v_arrival_time timestamptz;
  v_capacity integer;
  v_price numeric;
  v_default_seat_class text;
  v_bus_active boolean;
  v_trip_status text;
  v_splits jsonb := COALESCE(p_splits, '[]'::jsonb);
  v_split_total numeric;
BEGIN
  p_idempotency_key := NULLIF(btrim(p_idempotency_key), '');
  p_ticket_number := NULLIF(btrim(p_ticket_number), '');
  p_payment_reference := NULLIF(btrim(p_payment_reference), '');

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A stable idempotency key is required' USING ERRCODE = '22023';
  END IF;

  IF length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'Idempotency key must not exceed 200 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_payment_method NOT IN ('cash', 'tpa', 'tpa_dinheiro', 'referencia') THEN
    RAISE EXCEPTION 'Unsupported payment method' USING ERRCODE = '22023';
  END IF;

  IF p_payment_status NOT IN ('pending', 'paid') THEN
    RAISE EXCEPTION 'Unsupported initial payment status' USING ERRCODE = '22023';
  END IF;

  IF p_payment_method IN ('cash', 'tpa', 'tpa_dinheiro')
     AND p_payment_status <> 'paid'
  THEN
    RAISE EXCEPTION 'Counter payments must be paid atomically' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_booked_by AND p.role IN ('agent', 'admin')
  ) THEN
    RAISE EXCEPTION 'Only agents can create counter bookings' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('booking:' || p_booked_by::text || ':' || p_idempotency_key, 0)
  );

  SELECT tk.* INTO v_existing
  FROM public.tickets tk
  WHERE (tk.booked_by = p_booked_by AND tk.idempotency_key = p_idempotency_key)
     OR (p_ticket_number IS NOT NULL AND tk.ticket_number = p_ticket_number)
  ORDER BY (tk.booked_by = p_booked_by AND tk.idempotency_key = p_idempotency_key) DESC
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.booked_by IS DISTINCT FROM p_booked_by
       OR v_existing.trip_id IS DISTINCT FROM p_trip_id
       OR v_existing.passenger_id IS DISTINCT FROM p_passenger_id
       OR v_existing.seat_number IS DISTINCT FROM p_seat_number
    THEN
      RAISE EXCEPTION 'Idempotency key already belongs to another booking'
        USING ERRCODE = '23505';
    END IF;

    IF v_existing.payment_status = 'paid'
       AND v_existing.payment_method IN ('cash', 'tpa', 'tpa_dinheiro')
       AND NOT EXISTS (
         SELECT 1 FROM public.payment_transactions pt
         WHERE pt.ticket_id = v_existing.id AND pt.status = 'completed'
       )
    THEN
      RAISE EXCEPTION 'Existing paid ticket is missing its payment transaction'
        USING ERRCODE = '55000';
    END IF;

    RETURN QUERY SELECT
      v_existing.id,
      v_existing.ticket_number,
      v_existing.trip_id,
      v_existing.passenger_id,
      v_existing.booked_by,
      v_existing.seat_number,
      v_existing.seat_class,
      v_existing.price_paid_usd,
      v_existing.payment_reference,
      v_existing.payment_status,
      v_existing.payment_method,
      v_existing.qr_code_data,
      v_existing.status,
      true;
    RETURN;
  END IF;

  SELECT
    tr.bus_id,
    tr.departure_time,
    tr.arrival_time,
    b.capacity,
    tr.price_usd,
    tr.seat_class,
    b.is_active,
    tr.status
  INTO
    v_bus_id,
    v_departure_time,
    v_arrival_time,
    v_capacity,
    v_price,
    v_default_seat_class,
    v_bus_active,
    v_trip_status
  FROM public.trips tr
  JOIN public.buses b ON b.id = tr.bus_id
  WHERE tr.id = p_trip_id;

  IF v_bus_id IS NULL THEN
    RAISE EXCEPTION 'Trip not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_bus_active OR v_trip_status NOT IN ('scheduled', 'boarding') THEN
    RAISE EXCEPTION 'Trip is not available for sale' USING ERRCODE = '22023';
  END IF;

  IF p_seat_number < 2 OR p_seat_number > v_capacity THEN
    RAISE EXCEPTION 'Seat must be between 2 and %', v_capacity USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_splits) <> 'array' THEN
    RAISE EXCEPTION 'Payment splits must be an array' USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(v_splits) > 0 THEN
    IF p_payment_method <> 'tpa_dinheiro' THEN
      RAISE EXCEPTION 'Splits are only valid for TPA/cash payments' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_splits) AS part(value)
      WHERE part.value->>'method' NOT IN ('cash', 'tpa')
         OR COALESCE((part.value->>'amount')::numeric, 0) <= 0
    ) THEN
      RAISE EXCEPTION 'Invalid payment split' USING ERRCODE = '22023';
    END IF;

    SELECT SUM((part.value->>'amount')::numeric)
      INTO v_split_total
    FROM jsonb_array_elements(v_splits) AS part(value);

    IF abs(v_split_total - v_price) > 0.01 THEN
      RAISE EXCEPTION 'Split payment total must equal ticket price' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Match guard_seat_conflict/create_seat_hold so ticket and hold races share
  -- one lock. The trigger repeats the ticket check as defense in depth.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_bus_id::text || ':' || p_seat_number::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.online_bookings hold
    JOIN public.trips sibling ON sibling.id = hold.trip_id
    WHERE sibling.bus_id = v_bus_id
      AND sibling.departure_time < v_arrival_time
      AND v_departure_time < sibling.arrival_time
      AND hold.seat_number = p_seat_number
      AND hold.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Seat currently reserved for an online payment'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.tickets (
    trip_id,
    passenger_id,
    booked_by,
    booking_source,
    seat_class,
    seat_number,
    ticket_number,
    price_paid_usd,
    payment_status,
    payment_method,
    payment_reference,
    qr_code_data,
    idempotency_key
  ) VALUES (
    p_trip_id,
    p_passenger_id,
    p_booked_by,
    'mobile_app',
    COALESCE(NULLIF(p_seat_class, ''), v_default_seat_class),
    p_seat_number,
    p_ticket_number,
    v_price,
    p_payment_status,
    p_payment_method,
    CASE WHEN p_payment_method = 'referencia' THEN NULL ELSE p_payment_reference END,
    'TKT-' || p_trip_id::text || '-' || p_seat_number::text,
    p_idempotency_key
  )
  RETURNING * INTO v_ticket;

  IF p_payment_method IN ('cash', 'tpa', 'tpa_dinheiro') THEN
    IF jsonb_array_length(v_splits) > 0 THEN
      INSERT INTO public.payment_transactions (
        ticket_id, amount_usd, currency, payment_method, status, transaction_id
      )
      SELECT
        v_ticket.id,
        (part.value->>'amount')::numeric,
        'USD',
        part.value->>'method',
        'completed',
        'agent-' || gen_random_uuid()::text || '-' || (part.ordinality - 1)::text
      FROM jsonb_array_elements(v_splits) WITH ORDINALITY AS part(value, ordinality);
    ELSE
      INSERT INTO public.payment_transactions (
        ticket_id, amount_usd, currency, payment_method, status, transaction_id
      ) VALUES (
        v_ticket.id,
        v_price,
        'USD',
        p_payment_method,
        'completed',
        'txn-' || gen_random_uuid()::text
      );
    END IF;
  END IF;

  IF p_payment_method = 'referencia' AND p_payment_reference IS NOT NULL THEN
    UPDATE public.tickets tk
    SET payment_reference = p_payment_reference
    WHERE tk.id = v_ticket.id
    RETURNING * INTO v_ticket;
  END IF;

  RETURN QUERY SELECT
    v_ticket.id,
    v_ticket.ticket_number,
    v_ticket.trip_id,
    v_ticket.passenger_id,
    v_ticket.booked_by,
    v_ticket.seat_number,
    v_ticket.seat_class,
    v_ticket.price_paid_usd,
    v_ticket.payment_reference,
    v_ticket.payment_status,
    v_ticket.payment_method,
    v_ticket.qr_code_data,
    v_ticket.status,
    false;
END;
$function$;

REVOKE ALL ON FUNCTION public.book_agent_ticket_atomic(
  uuid, uuid, uuid, integer, text, text, text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.book_agent_ticket_atomic(
  uuid, uuid, uuid, integer, text, text, text, text, text, text, jsonb
) TO service_role;
