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

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    if (!requireSameOrigin(req, res)) return;
    try {
        const { setupToken, email, username, fullName, password } = parseBody(req);
        const configuredToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
        if (!configuredToken) return sendJson(res, 503, { error: 'Administrator setup is not configured' });
        if (typeof setupToken !== 'string' || setupToken !== configuredToken) {
            return sendJson(res, 403, { error: 'Invalid administrator setup token' });
        }
        if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(username.trim())
            || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
            || typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.trim().length > 120
            || typeof password !== 'string' || password.length < 12 || password.length > 128) {
            return sendJson(res, 400, { error: 'Enter a valid name, username, email, and password of at least 12 characters' });
        }
        const passwordHash = await hashPassword(password);
        const [user] = await getDb().begin(async (sql) => {
            const [existing] = await sql`SELECT id FROM users WHERE role = 'admin' LIMIT 1`;
            if (existing) return [];
            return sql`
                INSERT INTO users (username, email, full_name, password_hash, role)
                VALUES (${username.trim()}, ${email.trim().toLowerCase()}, ${fullName.trim()}, ${passwordHash}, 'admin')
                RETURNING id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                          notifications, balance_jobs, open_orders, order_history, futures_positions,
                          created_at, updated_at
            `;
        });
        if (!user) return sendJson(res, 409, { error: 'Administrator setup has already been completed' });
        await createSession(user.id, res);
        sendJson(res, 201, { user: publicUser(user) });
    } catch (error) {
        handleError(res, error, 'Unable to initialize the administrator account');
    }
};
