const { getDb, handleError, methodNotAllowed, publicUser, requireUser, sendJson } = require('../../_lib/http');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    try {
        const admin = await requireUser(req, res, 'admin');
        if (!admin) return;
        const users = await getDb()`
            SELECT id, username, email, full_name, role, wallet, funding_wallet, transactions,
                   notifications, balance_jobs, open_orders, order_history, futures_positions,
                   created_at, updated_at
            FROM users
            WHERE role = 'user'
            ORDER BY created_at DESC
            LIMIT 1000
        `;
        sendJson(res, 200, { users: users.map(publicUser) });
    } catch (error) {
        handleError(res, error, 'Unable to load registered accounts');
    }
};
