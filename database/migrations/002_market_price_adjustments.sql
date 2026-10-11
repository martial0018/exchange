ALTER TABLE admin_audit_log
    DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;

ALTER TABLE admin_audit_log
    ADD CONSTRAINT admin_audit_log_action_check
    CHECK (action IN ('balance_adjustment', 'balance_credit', 'wallet_reset', 'price_adjustment'));

CREATE TABLE IF NOT EXISTS market_price_adjustments (
    market_type TEXT NOT NULL CHECK (market_type IN ('spot', 'futures')),
    symbol TEXT NOT NULL CHECK (symbol ~ '^[A-Z0-9]{2,30}$'),
    percentage NUMERIC(7, 3) NOT NULL CHECK (percentage >= -99.990 AND percentage <= 1000.000),
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (market_type, symbol)
);
