const { getDb, handleError, methodNotAllowed, parseBody, publicUser, requireSameOrigin, requireUser, sendJson } = require('../_lib/http');

module.exports = async function handler(req, res) {
    if (req.method !== 'PUT') return methodNotAllowed(res, ['PUT']);
    if (!requireSameOrigin(req, res)) return;
    try {
        const user = await requireUser(req, res);
        if (!user) return;
        const { fullName, email } = parseBody(req);
        if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.trim().length > 120
            || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            return sendJson(res, 400, { error: 'Enter a valid name and email address' });
        }
        const [updated] = await getDb()`
            UPDATE users
            SET full_name = ${fullName.trim()}, email = ${email.trim().toLowerCase()}, updated_at = NOW()
            WHERE id = ${user.id}
            RETURNING id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                      notifications, balance_jobs, open_orders, order_history, futures_positions,
                      created_at, updated_at
        `;
        sendJson(res, 200, { user: publicUser(updated) });
    } catch (error) {
        handleError(res, error, 'Unable to update profile');
    }
};
