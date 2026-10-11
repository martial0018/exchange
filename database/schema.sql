CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    wallet JSONB NOT NULL DEFAULT '[]'::jsonb,
    funding_wallet JSONB NOT NULL DEFAULT '[]'::jsonb,
    transactions JSONB NOT NULL DEFAULT '[]'::jsonb,
    notifications JSONB NOT NULL DEFAULT '[]'::jsonb,
    balance_jobs JSONB NOT NULL DEFAULT '[]'::jsonb,
    open_orders JSONB NOT NULL DEFAULT '[]'::jsonb,
    order_history JSONB NOT NULL DEFAULT '[]'::jsonb,
    futures_positions JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci_idx ON users (LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_ci_idx ON users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin_idx ON users (role) WHERE role = 'admin';

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
    identifier TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN ('balance_adjustment', 'balance_credit', 'wallet_reset', 'price_adjustment', 'deposit_address_update')),
    before_wallet JSONB NOT NULL,
    after_wallet JSONB NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    request_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (actor_id, request_id)
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_target_user_idx ON admin_audit_log (target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_price_adjustments (
    market_type TEXT NOT NULL CHECK (market_type IN ('spot', 'futures')),
    symbol TEXT NOT NULL CHECK (symbol ~ '^[A-Z0-9]{2,30}$'),
    percentage NUMERIC(7, 3) NOT NULL CHECK (percentage >= -99.990 AND percentage <= 1000.000),
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (market_type, symbol)
);

CREATE TABLE IF NOT EXISTS crypto_deposit_addresses (
    asset TEXT NOT NULL CHECK (asset IN ('USDT', 'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX')),
    network TEXT NOT NULL CHECK (network IN ('Bitcoin', 'Ethereum (ERC-20)', 'BNB Smart Chain (BEP-20)', 'Tron (TRC-20)', 'Solana', 'XRP Ledger', 'Cardano', 'Dogecoin', 'Avalanche C-Chain')),
    address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 200),
    memo TEXT NOT NULL DEFAULT '' CHECK (length(memo) <= 120),
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (asset, network)
);
