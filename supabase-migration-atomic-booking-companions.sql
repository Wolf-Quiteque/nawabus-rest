BEGIN;

-- A ticket represents exactly one occupied seat, so it can have at most one
-- traveller override. This also gives the retry path a deterministic conflict
-- target instead of creating duplicate companion rows.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_companions_ticket_id_key
  ON public.ticket_companions (ticket_id);

-- Keep the original RPC available while the API deployment rolls forward.
-- The wrapper participates in the same PostgreSQL transaction as the existing
-- ticket/payment function, making the companion row part of the booking commit.
CREATE OR REPLACE FUNCTION public.book_agent_ticket_atomic_v2(
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
  p_splits jsonb DEFAULT '[]'::jsonb,
  p_companion_name text DEFAULT NULL,
  p_companion_phone text DEFAULT NULL
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
  v_result record;
BEGIN
  p_companion_name := NULLIF(btrim(p_companion_name), '');
  p_companion_phone := NULLIF(btrim(p_companion_phone), '');

  IF p_companion_phone IS NOT NULL AND p_companion_name IS NULL THEN
    RAISE EXCEPTION 'Companion phone requires a companion name'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.book_agent_ticket_atomic(
    p_trip_id,
    p_passenger_id,
    p_booked_by,
    p_seat_number,
    p_payment_method,
    p_payment_status,
    p_idempotency_key,
    p_seat_class,
    p_payment_reference,
    p_ticket_number,
    p_splits
  );

  IF p_companion_name IS NOT NULL THEN
    INSERT INTO public.ticket_companions (ticket_id, name, phone)
    VALUES (v_result.ticket_id, p_companion_name, p_companion_phone)
    -- Do not name ticket_id as the conflict target here. The RETURNS TABLE
    -- output variable has the same name, so PL/pgSQL treats
    -- ON CONFLICT (ticket_id) as an ambiguous column reference at runtime.
    -- There is only one unique key relevant to this insert, and the
    -- verification below still rejects a retry with different traveller data.
    ON CONFLICT DO NOTHING;

    -- A retry with the same idempotency key must describe the same traveller.
    IF NOT EXISTS (
      SELECT 1
      FROM public.ticket_companions companion
      WHERE companion.ticket_id = v_result.ticket_id
        AND companion.name = p_companion_name
        AND companion.phone IS NOT DISTINCT FROM p_companion_phone
    ) THEN
      RAISE EXCEPTION 'Idempotency key already belongs to another companion'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_result.ticket_id::uuid,
    v_result.ticket_number::text,
    v_result.trip_id::uuid,
    v_result.passenger_id::uuid,
    v_result.booked_by::uuid,
    v_result.seat_number::integer,
    v_result.seat_class::text,
    v_result.price_paid_usd::numeric,
    v_result.payment_reference::text,
    v_result.payment_status::text,
    v_result.payment_method::text,
    v_result.qr_code_data::text,
    v_result.status::text,
    v_result.was_idempotent::boolean;
END;
$function$;

REVOKE ALL ON FUNCTION public.book_agent_ticket_atomic_v2(
  uuid, uuid, uuid, integer, text, text, text, text, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.book_agent_ticket_atomic_v2(
  uuid, uuid, uuid, integer, text, text, text, text, text, text, jsonb, text, text
) TO service_role;

COMMIT;
