const NETWORKS_BY_ASSET = {
    USDT: ['Ethereum (ERC-20)', 'BNB Smart Chain (BEP-20)', 'Tron (TRC-20)', 'Solana'],
    BTC: ['Bitcoin'],
    ETH: ['Ethereum (ERC-20)'],
    SOL: ['Solana'],
    BNB: ['BNB Smart Chain (BEP-20)'],
    XRP: ['XRP Ledger'],
    ADA: ['Cardano'],
    DOGE: ['Dogecoin'],
    AVAX: ['Avalanche C-Chain']
};

function validDepositNetwork(asset, network) {
    return typeof asset === 'string'
        && typeof network === 'string'
        && Array.isArray(NETWORKS_BY_ASSET[asset])
        && NETWORKS_BY_ASSET[asset].includes(network);
}

module.exports = { validDepositNetwork };
