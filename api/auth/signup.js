const {
    createSession,
    getDb,
    handleError,
    hashPassword,
    methodNotAllowed,
    parseBody,
    publicUser,
    requireSameOrigin,
    sendJson
} = require('../_lib/http');
const { sendTelegramActivity } = require('../_lib/telegram-alerts');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    if (!requireSameOrigin(req, res)) return;
    try {
        const { username, email, fullName, password } = parseBody(req);
        if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(username.trim())
            || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
            || typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.trim().length > 120
            || typeof password !== 'string' || password.length < 12 || password.length > 128) {
            return sendJson(res, 400, { error: 'Enter a valid name, username, email, and password of at least 12 characters' });
        }
        const passwordHash = await hashPassword(password);
        const [user] = await getDb()`
            INSERT INTO users (username, email, full_name, password_hash, role, wallet)
            VALUES (
                ${username.trim()},
                ${email.trim().toLowerCase()},
                ${fullName.trim()},
                ${passwordHash},
                'user',
                ${JSON.stringify([
                    { asset: 'BTC', total: 0, available: 0, inOrders: 0 },
                    { asset: 'USDT', total: 0, available: 0, inOrders: 0 },
                    { asset: 'ETH', total: 0, available: 0, inOrders: 0 }
                ])}::jsonb
            )
            RETURNING id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                      notifications, balance_jobs, open_orders, order_history, futures_positions,
                      created_at, updated_at, xmin::text AS version
        `;
        await createSession(user.id, res);
        await sendTelegramActivity('New account created', user);
        sendJson(res, 201, { user: publicUser(user) });
    } catch (error) {
        handleError(res, error, 'Unable to create account');
    }
};
