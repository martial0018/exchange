const {
    getDb,
    handleError,
    hashPassword,
    methodNotAllowed,
    parseBody,
    requireSameOrigin,
    requireUser,
    sendJson,
    verifyPassword
} = require('../_lib/http');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    if (!requireSameOrigin(req, res)) return;
    try {
        const user = await requireUser(req, res);
        if (!user) return;
        const { currentPassword, newPassword } = parseBody(req);
        const db = getDb();
        const [record] = await db`SELECT password_hash FROM users WHERE id = ${user.id}`;
        if (!record || typeof currentPassword !== 'string' || !await verifyPassword(currentPassword, record.password_hash)) {
            return sendJson(res, 401, { error: 'Current password is incorrect' });
        }
        if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128) {
            return sendJson(res, 400, { error: 'Choose a password with at least 12 characters' });
        }
        const passwordHash = await hashPassword(newPassword);
        await db`UPDATE users SET password_hash = ${passwordHash}, updated_at = NOW() WHERE id = ${user.id}`;
        await db`DELETE FROM sessions WHERE user_id = ${user.id}`;
        sendJson(res, 200, { ok: true });
    } catch (error) {
        handleError(res, error, 'Unable to change password');
    }
};
