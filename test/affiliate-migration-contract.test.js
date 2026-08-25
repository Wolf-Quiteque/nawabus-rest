import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../../admin-app/supabase/migrations/20260821_affiliate_program.sql', import.meta.url);
const sql = await readFile(migrationUrl, 'utf8');

test('affiliate applications remain separate from the existing single profile role', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.affiliate_accounts/);
  assert.match(sql, /user_id uuid PRIMARY KEY REFERENCES public\.profiles\(id\)/);
  assert.doesNotMatch(sql, /ALTER TABLE public\.profiles[\s\S]*affiliate/);
});

test('one affiliate code resolves fixed discount and commission per ticket', () => {
  assert.match(sql, /coupons_one_code_per_affiliate/);
  assert.match(sql, /resolve_promotion_for_ticket/);
  assert.match(sql, /v_discount \+ v_commission > p_base_fare_kz/);
  assert.match(sql, /p_passenger_id = v_affiliate\.user_id/);
});

test('tickets retain the financial and attribution snapshots used by reports', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS base_fare_kz numeric/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS passenger_discount_kz numeric/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS affiliate_commission_kz numeric/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS attribution_source text/);
  assert.match(sql, /price_paid_usd = v_final_fare/);
});

test('paid tickets earn once and cancelled or refunded tickets reverse once', () => {
  assert.match(sql, /UNIQUE \(redemption_id, entry_type\)/);
  assert.match(sql, /entry_type, amount_kz, description[\s\S]*'commission'/);
  assert.match(sql, /entry_type, amount_kz, description[\s\S]*'reversal'[\s\S]*-v_redemption\.commission_amount_kz/);
  assert.match(sql, /NEW\.payment_status IN \('failed', 'refunded'\)[\s\S]*NEW\.status IN \('cancelled', 'refunded'\)/);
});

test('payouts require proof and exactly allocate previously unpaid ledger entries', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.create_affiliate_payout/);
  assert.match(sql, /Payment proof is required/);
  assert.match(sql, /v_expected_amount - round\(p_amount_kz, 2\)/);
  assert.match(sql, /All unpaid reversals must be included in the payout/);
  assert.match(sql, /ledger_entry_id uuid NOT NULL UNIQUE/);
  assert.match(sql, /affiliate-payment-proofs/);
});

test('affiliate financial tables use row-level ownership policies', () => {
  assert.match(sql, /ALTER TABLE public\.affiliate_accounts ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE public\.affiliate_ledger_entries ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /affiliate_id = auth\.uid\(\)/);
});
