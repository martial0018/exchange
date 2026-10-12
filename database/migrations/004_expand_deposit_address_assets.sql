ALTER TABLE crypto_deposit_addresses
    DROP CONSTRAINT IF EXISTS crypto_deposit_addresses_asset_check;

ALTER TABLE crypto_deposit_addresses
    ADD CONSTRAINT crypto_deposit_addresses_asset_check
    CHECK (asset ~ '^[A-Z0-9]{2,20}$');
