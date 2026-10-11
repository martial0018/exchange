ALTER TABLE admin_audit_log
    DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;

ALTER TABLE admin_audit_log
    ADD CONSTRAINT admin_audit_log_action_check
    CHECK (action IN ('balance_adjustment', 'balance_credit', 'wallet_reset', 'price_adjustment', 'deposit_address_update'));

CREATE TABLE IF NOT EXISTS crypto_deposit_addresses (
    asset TEXT NOT NULL CHECK (asset IN ('USDT', 'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX')),
    network TEXT NOT NULL CHECK (network IN ('Bitcoin', 'Ethereum (ERC-20)', 'BNB Smart Chain (BEP-20)', 'Tron (TRC-20)', 'Solana', 'XRP Ledger', 'Cardano', 'Dogecoin', 'Avalanche C-Chain')),
    address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 200),
    memo TEXT NOT NULL DEFAULT '' CHECK (length(memo) <= 120),
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (asset, network)
);
