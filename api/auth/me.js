const {
    clearSessionCookie,
    getDb,
    getSessionUser,
    handleError,
    methodNotAllowed,
    parseBody,
    publicUser,
    requireSameOrigin,
    sendJson
} = require('../_lib/http');

module.exports = async function handler(req, res) {
    try {
        if (req.method === 'GET') {
            const user = await getSessionUser(req);
            return user ? sendJson(res, 200, { user: publicUser(user) }) : sendJson(res, 401, { error: 'Not signed in' });
        }
        if (req.method === 'DELETE') {
            if (!requireSameOrigin(req, res)) return;
            const token = (req.headers.cookie || '').split(';')
                .map((part) => part.trim())
                .find((part) => part.startsWith('__Host-exchange_session='))
                ?.slice('__Host-exchange_session='.length);
            if (token) {
                const crypto = require('node:crypto');
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                await getDb()`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
            }
            clearSessionCookie(res);
            return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'PUT') {
            if (!requireSameOrigin(req, res)) return;
            const user = await getSessionUser(req);
            if (!user) return sendJson(res, 401, { error: 'Sign in to continue' });
            const body = parseBody(req);
            if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 200_000) {
                return sendJson(res, 413, { error: 'Account update is too large' });
            }
            const allowed = ['notifications', 'openOrders', 'orderHistory', 'futuresPositions'];
            if (Object.keys(body).some((key) => !allowed.includes(key))) {
                return sendJson(res, 400, { error: 'Unsupported account data field' });
            }
            const jsonFields = [
                ['notifications', 'notifications'],
                ['openOrders', 'open orders'],
                ['orderHistory', 'order history'],
                ['futuresPositions', 'futures positions']
            ];
            for (const [field, label] of jsonFields) {
                if (body[field] !== undefined && (!Array.isArray(body[field]) || body[field].length > 1000)) {
                    return sendJson(res, 400, { error: `Invalid ${label} data` });
                }
            }
            const [freshUser] = await getDb()`
                UPDATE users SET
                    notifications = COALESCE(${body.notifications === undefined ? null : JSON.stringify(body.notifications)}::jsonb, notifications),
                    open_orders = COALESCE(${body.openOrders === undefined ? null : JSON.stringify(body.openOrders)}::jsonb, open_orders),
                    order_history = COALESCE(${body.orderHistory === undefined ? null : JSON.stringify(body.orderHistory)}::jsonb, order_history),
                    futures_positions = COALESCE(${body.futuresPositions === undefined ? null : JSON.stringify(body.futuresPositions)}::jsonb, futures_positions),
                    updated_at = NOW()
                WHERE id = ${user.id}
                RETURNING id, username, email, full_name, role, wallet, funding_wallet, transactions,
                       notifications, balance_jobs, open_orders, order_history, futures_positions,
                       created_at, updated_at
            `;
            if (!freshUser) return sendJson(res, 404, { error: 'Account not found' });
            return sendJson(res, 200, { user: publicUser(freshUser) });
        }
        return methodNotAllowed(res, ['GET', 'PUT', 'DELETE']);
    } catch (error) {
        handleError(res, error, 'Unable to access account');
    }
};
