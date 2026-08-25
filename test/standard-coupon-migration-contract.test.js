import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../../admin-app/supabase/migrations/20260825_standard_coupon_discount_modes.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

test('standalone coupons support exactly one discount mode', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS discount_type text/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS discount_amount_kz numeric/);
  assert.match(sql, /discount_type = 'percentage'[\s\S]*discount_amount_kz IS NULL/);
  assert.match(sql, /discount_type = 'fixed_kz'[\s\S]*discount_percentage IS NULL/);
});

test('existing standalone coupons remain percentage coupons', () => {
  assert.match(sql, /UPDATE public\.coupons[\s\S]*discount_type = 'percentage'[\s\S]*kind = 'standard'/);
});

test('fixed Kz discounts never make a ticket amount negative', () => {
  assert.match(sql, /least\(round\(v_coupon\.discount_amount_kz, 2\), p_base_fare_kz\)/);
  assert.match(sql, /round\(p_base_fare_kz - v_discount, 2\)/);
});

test('affiliate coupon values remain sourced from the affiliate account', () => {
  assert.match(sql, /kind = 'affiliate'[\s\S]*discount_type IS NULL[\s\S]*discount_amount_kz IS NULL/);
  assert.match(sql, /v_affiliate\.passenger_discount_kz/);
  assert.match(sql, /v_affiliate\.commission_per_ticket_kz/);
});
