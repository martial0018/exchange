const { getDb, handleError, methodNotAllowed, requireUser, sendJson } = require('../_lib/http');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    try {
        const admin = await requireUser(req, res, 'admin');
        if (!admin) return;
        const entries = await getDb()`
            SELECT log.id, log.action, log.before_wallet, log.after_wallet, log.details, log.created_at,
                   actor.username AS actor_username, target.username AS target_username
            FROM admin_audit_log log
            LEFT JOIN users actor ON actor.id = log.actor_id
            LEFT JOIN users target ON target.id = log.target_user_id
            ORDER BY log.created_at DESC
            LIMIT 50
        `;
        sendJson(res, 200, {
            entries: entries.map((entry) => ({
                id: entry.id,
                action: entry.action,
                beforeWallet: entry.before_wallet,
                afterWallet: entry.after_wallet,
                details: entry.details,
                createdAt: entry.created_at,
                actorUsername: entry.actor_username || 'Deleted admin',
                targetUsername: ['price_adjustment', 'deposit_address_update'].includes(entry.action)
                    ? 'Shared settings'
                    : entry.target_username || 'Deleted account'
            }))
        });
    } catch (error) {
        handleError(res, error, 'Unable to load administrator history');
    }
};
