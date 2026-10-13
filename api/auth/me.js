const {
    clearSessionCookie,
    getDb,
    getSessionUser,
    handleError,
    methodNotAllowed,
    parseBody,
    publicUser,
    requireSameOrigin,
    sendJson,
    validWallet
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
            const allowed = ['version', 'wallet', 'fundingWallet', 'futuresWallet', 'transactions', 'notifications', 'openOrders', 'orderHistory', 'futuresPositions'];
            if (Object.keys(body).some((key) => !allowed.includes(key))) {
                return sendJson(res, 400, { error: 'Unsupported account data field' });
            }
            if (typeof body.version !== 'string' || !/^\d+$/.test(body.version)) {
                return sendJson(res, 428, { error: 'Your account data is out of date. Refresh before saving.' });
            }
            for (const field of ['wallet', 'fundingWallet', 'futuresWallet']) {
                if (body[field] !== undefined && !validWallet(body[field])) {
                    const walletName = { wallet: 'Spot wallet', fundingWallet: 'Funding wallet', futuresWallet: 'Futures wallet' }[field];
                    return sendJson(res, 400, { error: `Invalid ${walletName} data` });
                }
            }
            const jsonFields = [
                ['transactions', 'transactions'],
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
                    wallet = COALESCE(${body.wallet === undefined ? null : JSON.stringify(body.wallet)}::jsonb, wallet),
                    funding_wallet = COALESCE(${body.fundingWallet === undefined ? null : JSON.stringify(body.fundingWallet)}::jsonb, funding_wallet),
                    futures_wallet = COALESCE(${body.futuresWallet === undefined ? null : JSON.stringify(body.futuresWallet)}::jsonb, futures_wallet),
                    transactions = COALESCE(${body.transactions === undefined ? null : JSON.stringify(body.transactions)}::jsonb, transactions),
                    notifications = COALESCE(${body.notifications === undefined ? null : JSON.stringify(body.notifications)}::jsonb, notifications),
                    open_orders = COALESCE(${body.openOrders === undefined ? null : JSON.stringify(body.openOrders)}::jsonb, open_orders),
                    order_history = COALESCE(${body.orderHistory === undefined ? null : JSON.stringify(body.orderHistory)}::jsonb, order_history),
                    futures_positions = COALESCE(${body.futuresPositions === undefined ? null : JSON.stringify(body.futuresPositions)}::jsonb, futures_positions),
                    updated_at = NOW()
                WHERE id = ${user.id} AND xmin::text = ${body.version}
                RETURNING id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                       notifications, balance_jobs, open_orders, order_history, futures_positions,
                       created_at, updated_at, xmin::text AS version
            `;
            if (!freshUser) {
                const [latestUser] = await getDb()`
                    SELECT id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                           notifications, balance_jobs, open_orders, order_history, futures_positions,
                           created_at, updated_at, xmin::text AS version
                    FROM users WHERE id = ${user.id}
                `;
                if (!latestUser) return sendJson(res, 404, { error: 'Account not found' });
                return sendJson(res, 409, {
                    error: 'Your account changed elsewhere. The latest balance and account data have been refreshed.',
                    user: publicUser(latestUser)
                });
            }
            return sendJson(res, 200, { user: publicUser(freshUser) });
        }
        return methodNotAllowed(res, ['GET', 'PUT', 'DELETE']);
    } catch (error) {
        handleError(res, error, 'Unable to access account');
    }
};
