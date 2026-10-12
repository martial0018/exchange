const DEPOSIT_NETWORKS = [
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
];

function validDepositNetwork(asset, network) {
    return typeof asset === 'string'
        && typeof network === 'string'
        && /^[A-Z0-9]{2,20}$/.test(asset)
        && DEPOSIT_NETWORKS.includes(network);
}

module.exports = { validDepositNetwork };
