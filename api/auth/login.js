const {
    createSession,
    getDb,
    handleError,
    methodNotAllowed,
    parseBody,
    publicUser,
    requireSameOrigin,
    sendJson,
    verifyPassword
} = require('../_lib/http');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    if (!requireSameOrigin(req, res)) return;
    try {
        const { identifier, password } = parseBody(req);
        if (typeof identifier !== 'string' || !identifier.trim() || typeof password !== 'string' || !password) {
            return sendJson(res, 400, { error: 'Enter your username or email and password' });
        }
        const db = getDb();
        const normalized = identifier.trim().toLowerCase();
        const [attempt] = await db`
            SELECT attempts, locked_until FROM login_attempts WHERE identifier = ${normalized}
        `;
        if (attempt?.locked_until && new Date(attempt.locked_until).getTime() > Date.now()) {
            return sendJson(res, 429, { error: 'Too many sign-in attempts. Try again later.' });
        }
        const [user] = await db`
            SELECT id, username, email, full_name, role, password_hash, wallet, funding_wallet, futures_wallet,
                   transactions, notifications, balance_jobs, open_orders, order_history,
                   futures_positions, created_at, updated_at, xmin::text AS version
            FROM users
            WHERE LOWER(username) = ${normalized} OR LOWER(email) = ${normalized}
            LIMIT 1
        `;
        const valid = user ? await verifyPassword(password, user.password_hash) : false;
        if (!valid) {
            const attempts = attempt?.attempts || 0;
            const lockedUntil = attempts >= 9 ? new Date(Date.now() + 15 * 60_000) : null;
            await db`
                INSERT INTO login_attempts (identifier, attempts, locked_until, updated_at)
                VALUES (${normalized}, ${attempts + 1}, ${lockedUntil}, NOW())
                ON CONFLICT (identifier) DO UPDATE
                SET attempts = EXCLUDED.attempts,
                    locked_until = EXCLUDED.locked_until,
                    updated_at = NOW()
            `;
            return sendJson(res, 401, { error: 'Invalid username/email or password' });
        }
        await db`DELETE FROM login_attempts WHERE identifier = ${normalized}`;
        await createSession(user.id, res);
        const [loggedInUser] = await db`
            UPDATE users SET last_login_at = NOW()
            WHERE id = ${user.id}
            RETURNING id, username, email, full_name, role, wallet, funding_wallet, futures_wallet,
                      transactions, notifications, balance_jobs, open_orders, order_history,
                      futures_positions, created_at, updated_at, xmin::text AS version
        `;
        sendJson(res, 200, { user: publicUser(loggedInUser) });
    } catch (error) {
        handleError(res, error, 'Unable to sign in');
    }
};
