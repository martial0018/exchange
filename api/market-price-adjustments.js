const { getDb, handleError, methodNotAllowed, sendJson } = require('./_lib/http');
const handleMarketData = require('./_lib/market-data');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    const resource = new URL(req.url, 'https://exchange.invalid').searchParams.get('resource');
    if (resource === 'market-data') return handleMarketData(req, res);
    try {
        if (resource === 'deposit-addresses') {
            const addresses = await getDb()`
                SELECT asset, network, address, memo, updated_at
                FROM crypto_deposit_addresses
                ORDER BY asset, network
            `;
            sendJson(res, 200, {
                addresses: addresses.map((row) => ({
                    asset: row.asset,
                    network: row.network,
                    address: row.address,
                    memo: row.memo,
                    updatedAt: row.updated_at
                }))
            });
            return;
        }
        const rows = await getDb()`
            SELECT market_type, symbol, percentage
            FROM market_price_adjustments
            ORDER BY market_type, symbol
        `;
        sendJson(res, 200, {
            adjustments: rows.map((row) => ({
                marketType: row.market_type,
                symbol: row.symbol,
                percentage: Number(row.percentage)
            }))
        });
    } catch (error) {
        handleError(res, error, 'Unable to load market price adjustments');
    }
};
