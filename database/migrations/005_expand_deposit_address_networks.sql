ALTER TABLE crypto_deposit_addresses
    DROP CONSTRAINT IF EXISTS crypto_deposit_addresses_network_check;

ALTER TABLE crypto_deposit_addresses
    ADD CONSTRAINT crypto_deposit_addresses_network_check
    CHECK (network IN (
        'Algorand',
        'Aptos',
        'Arbitrum One',
        'Avalanche C-Chain',
        'Base',
        'Bitcoin',
        'Bitcoin Cash',
        'BNB Smart Chain (BEP-20)',
        'Cardano',
        'Celo',
        'Cosmos Hub',
        'Cronos',
        'Dogecoin',
        'Ethereum (ERC-20)',
        'Filecoin',
        'Gnosis Chain',
        'Hedera',
        'Injective',
        'Litecoin',
        'Linea',
        'Mantle',
        'NEAR',
        'Optimism',
        'Osmosis',
        'Polkadot',
        'Polygon PoS',
        'Scroll',
        'Sei',
        'Solana',
        'Stellar',
        'Sui',
        'Tezos',
        'TON',
        'Tron (TRC-20)',
        'XRP Ledger',
        'zkSync Era'
    ));
