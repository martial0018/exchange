const crypto = require('node:crypto');
const {
    getDb,
    handleError,
    methodNotAllowed,
    parseBody,
    requireSameOrigin,
    requireUser,
    sendJson
} = require('../_lib/http');

const VALID_MARKET_TYPES = new Set(['spot', 'futures']);

module.exports = async function handler(req, res) {
    if (!['GET', 'PUT'].includes(req.method)) return methodNotAllowed(res, ['GET', 'PUT']);
    try {
        const admin = await requireUser(req, res, 'admin');
        if (!admin) return;
        if (req.method === 'GET') {
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
            return;
        }
        if (!requireSameOrigin(req, res)) return;

        const body = parseBody(req);
        const marketType = typeof body.marketType === 'string' ? body.marketType : '';
        const symbol = typeof body.symbol === 'string' ? body.symbol : '';
        let percentage = body.percentage === null || body.percentage === '' ? null : Number(body.percentage);
        if (percentage === 0) percentage = null;
        if (!VALID_MARKET_TYPES.has(marketType)
            || !/^[A-Z0-9]{2,30}$/.test(symbol)
            || (percentage !== null && (!Number.isFinite(percentage)
                || percentage < -99.99 || percentage > 1000
                || Math.abs(percentage * 1000 - Math.round(percentage * 1000)) > 1e-7))) {
            sendJson(res, 400, { error: 'Choose a valid spot or futures pair and an adjustment from -99.99% to 1000% with at most three decimal places, or leave it blank to remove.' });
            return;
        }

        const db = getDb();
        const result = await db.begin(async (sql) => {
            const [before] = await sql`
                SELECT percentage FROM market_price_adjustments
                WHERE market_type = ${marketType} AND symbol = ${symbol}
                FOR UPDATE
            `;
            if (percentage === null) {
                await sql`
                    DELETE FROM market_price_adjustments
                    WHERE market_type = ${marketType} AND symbol = ${symbol}
                `;
            } else {
                await sql`
                    INSERT INTO market_price_adjustments (market_type, symbol, percentage, updated_by, updated_at)
                    VALUES (${marketType}, ${symbol}, ${percentage}, ${admin.id}, NOW())
                    ON CONFLICT (market_type, symbol) DO UPDATE
                    SET percentage = EXCLUDED.percentage, updated_by = EXCLUDED.updated_by, updated_at = NOW()
                `;
            }
            await sql`
                INSERT INTO admin_audit_log (
                    actor_id, action, before_wallet, after_wallet, details, request_id
                ) VALUES (
                    ${admin.id}, 'price_adjustment', '{}'::jsonb, '{}'::jsonb,
                    ${sql.json({
                        marketType,
                        symbol,
                        beforePercentage: before ? Number(before.percentage) : null,
                        percentage
                    })},
                    ${`price-adjustment:${crypto.randomUUID()}`}
                )
            `;
            return { marketType, symbol, percentage };
        });
        sendJson(res, 200, { adjustment: result });
    } catch (error) {
        handleError(res, error, 'Unable to save market price adjustment');
    }
};
