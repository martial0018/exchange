const MARKET_ENDPOINTS = {
    spot: new Map([
        ['/api/v3/exchangeInfo', new Set()],
        ['/api/v3/ticker/24hr', new Set(['symbol'])],
        ['/api/v3/klines', new Set(['symbol', 'interval', 'limit'])]
    ]),
    futures: new Map([
        ['/fapi/v1/exchangeInfo', new Set()],
        ['/fapi/v1/ticker/24hr', new Set(['symbol'])],
        ['/fapi/v1/premiumIndex', new Set(['symbol'])],
        ['/fapi/v1/klines', new Set(['symbol', 'interval', 'limit'])]
    ])
};

const BINANCE_ORIGINS = {
    spot: ['https://api.binance.com', 'https://data-api.binance.vision'],
    futures: ['https://fapi.binance.com']
};

function sendJson(res, status, body, cacheControl = 'no-store') {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl);
    res.end(JSON.stringify(body));
}

function validSymbol(value) {
    return typeof value === 'string' && /^[A-Z0-9]{2,30}$/.test(value);
}

function validInterval(value) {
    return typeof value === 'string'
        && /^(1s|[1-9][mhdw]|[1-9][0-9]m|1M)$/.test(value);
}

function validQuery(endpoint, query) {
    for (const key of query.keys()) {
        if (!endpoint.has(key)) return false;
    }
    if (query.has('symbol') && !validSymbol(query.get('symbol'))) return false;
    if (query.has('interval') && !validInterval(query.get('interval'))) return false;
    if (query.has('limit')) {
        const limit = Number(query.get('limit'));
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return false;
    }
    if (endpoint.has('interval')) {
        if (!query.has('symbol') || !query.has('interval')) return false;
    } else if (query.has('interval') || query.has('limit')) {
        return false;
    }
    return true;
}

function pickFields(value, fields) {
    return Object.fromEntries(fields
        .filter((field) => value[field] !== undefined)
        .map((field) => [field, value[field]]));
}

function compactResponse(endpointPath, payload) {
    if (endpointPath.endsWith('/exchangeInfo') && Array.isArray(payload.symbols)) {
        const fields = endpointPath.startsWith('/fapi/')
            ? ['symbol', 'status', 'contractType', 'baseAsset', 'quoteAsset', 'marginAsset']
            : ['symbol', 'status', 'baseAsset', 'quoteAsset', 'isSpotTradingAllowed'];
        return { symbols: payload.symbols.map((symbol) => pickFields(symbol, fields)) };
    }

    let fields;
    if (endpointPath.endsWith('/ticker/24hr')) {
        fields = endpointPath.startsWith('/fapi/')
            ? ['symbol', 'lastPrice', 'priceChangePercent', 'quoteVolume', 'closeTime']
            : ['symbol', 'lastPrice', 'priceChangePercent', 'quoteVolume', 'highPrice', 'lowPrice', 'closeTime'];
    } else if (endpointPath.endsWith('/premiumIndex')) {
        fields = ['symbol', 'lastFundingRate'];
    }
    if (!fields) return payload;
    return Array.isArray(payload)
        ? payload.map((item) => pickFields(item, fields))
        : pickFields(payload, fields);
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const requestUrl = new URL(req.url, 'https://exchange-seven-jade.vercel.app');
    const market = requestUrl.searchParams.get('market');
    const endpointPath = requestUrl.searchParams.get('endpoint');
    const endpoints = MARKET_ENDPOINTS[market];
    const allowedQuery = endpoints?.get(endpointPath);
    const upstreamQuery = new URLSearchParams();
    requestUrl.searchParams.forEach((value, key) => {
        if (key !== 'resource' && key !== 'market' && key !== 'endpoint') upstreamQuery.append(key, value);
    });

    if (!allowedQuery || !validQuery(allowedQuery, upstreamQuery)) {
        return sendJson(res, 400, { error: 'Invalid market-data request' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const errors = [];
    try {
        for (const origin of BINANCE_ORIGINS[market]) {
            try {
                const upstreamUrl = new URL(endpointPath, origin);
                upstreamUrl.search = upstreamQuery.toString();
                const upstream = await fetch(upstreamUrl, {
                    headers: { Accept: 'application/json' },
                    signal: controller.signal
                });
                if (!upstream.ok) {
                    errors.push(`${new URL(origin).host} returned HTTP ${upstream.status}`);
                    continue;
                }

                const payload = JSON.parse(await upstream.text());
                const body = JSON.stringify(compactResponse(endpointPath, payload));
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=15');
                res.end(body);
                return;
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                errors.push(`${new URL(origin).host}: ${error.message}`);
            }
        }

        console.error(`Unable to fetch Binance ${market} market data.`, errors);
        return sendJson(res, 502, {
            error: `Binance ${market} market data is temporarily unavailable`,
            upstreamErrors: errors
        });
    } catch (error) {
        console.error(`Unable to fetch Binance ${market} market data.`, error);
        const status = error.name === 'AbortError' ? 504 : 502;
        return sendJson(res, status, {
            error: `Binance ${market} market data is temporarily unavailable`,
            upstreamErrors: [...errors, error.message]
        });
    } finally {
        clearTimeout(timeout);
    }
};
