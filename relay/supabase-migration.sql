-- CoAgent Partners Program — Supabase Schema
-- Run this in Supabase Dashboard → SQL Editor

-- Users table (replaces TokenData in KV)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  user_id INTEGER UNIQUE NOT NULL,
  email TEXT,
  stripe_customer_id TEXT,
  model TEXT DEFAULT 'claude-sonnet-4-6',
  tier TEXT CHECK (tier IN ('founder', 'early_access', 'standard')) DEFAULT 'standard',
  referral_code TEXT UNIQUE NOT NULL,
  referred_by TEXT,
  stripe_connect_id TEXT,
  commission_rate NUMERIC(4,2) DEFAULT 0.10,
  accrued_commission INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  admin BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  usage JSONB DEFAULT '{
    "inputTokens": 0, "outputTokens": 0,
    "cacheWriteTokens": 0, "cacheReadTokens": 0,
    "llmCostUsd": 0, "embeddingTokens": 0, "embeddingCostUsd": 0,
    "composioActions": 0, "composioCostUsd": 0,
    "ttsCharacters": 0, "ttsCostUsd": 0,
    "whisperSeconds": 0, "whisperCostUsd": 0,
    "totalCostUsd": 0, "periodStart": ""
  }'::jsonb
);

-- Commission ledger — every commission event tracked
CREATE TABLE commissions (
  id SERIAL PRIMARY KEY,
  referrer_user_id INTEGER NOT NULL REFERENCES users(user_id),
  payer_user_id INTEGER NOT NULL REFERENCES users(user_id),
  amount_cents INTEGER NOT NULL,
  type TEXT CHECK (type IN ('payment', 'reversal', 'accrual', 'payout')) NOT NULL,
  stripe_transfer_id TEXT,
  stripe_invoice_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- User backups — metadata for cloud backup/restore
CREATE TABLE backups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  file_path TEXT NOT NULL,
  size_bytes BIGINT DEFAULT 0,
  checksum TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_users_token ON users(token);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_referral_code ON users(referral_code);
CREATE INDEX idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX idx_users_stripe_connect ON users(stripe_connect_id);
CREATE INDEX idx_users_tier ON users(tier);
CREATE INDEX idx_commissions_referrer ON commissions(referrer_user_id);
CREATE INDEX idx_commissions_payer ON commissions(payer_user_id);
CREATE INDEX idx_backups_user ON backups(user_id);

-- Row Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backups ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, so relay can do everything
-- Users can only read their own data via anon key
CREATE POLICY "Users can read own data" ON users
  FOR SELECT USING (auth.uid()::text = token);

CREATE POLICY "Users can read own commissions" ON commissions
  FOR SELECT USING (referrer_user_id IN (SELECT user_id FROM users WHERE token = auth.uid()::text));

CREATE POLICY "Users can manage own backups" ON backups
  FOR ALL USING (user_id IN (SELECT user_id FROM users WHERE token = auth.uid()::text));

-- Storage bucket for user backups
INSERT INTO storage.buckets (id, name, public)
VALUES ('backups', 'backups', false);

-- Storage policy — users can only access their own backup folder
CREATE POLICY "Users access own backups" ON storage.objects
  FOR ALL USING (bucket_id = 'backups' AND (storage.foldername(name))[1] = auth.uid()::text);
