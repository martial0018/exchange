ALTER TABLE users
    ADD COLUMN IF NOT EXISTS futures_wallet JSONB NOT NULL DEFAULT '[]'::jsonb;
