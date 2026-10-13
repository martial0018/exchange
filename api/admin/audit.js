const { getDb, handleError, methodNotAllowed, requireUser, sendJson } = require('../_lib/http');

function balanceFor(wallet, asset) {
    return Array.isArray(wallet) ? wallet.find((balance) => balance && balance.asset === asset) : null;
}

function normalizeAuditDetails(entry) {
    let parsedDetails = entry.details;
    if (typeof parsedDetails === 'string') parsedDetails = JSON.parse(parsedDetails);
    const details = parsedDetails && typeof parsedDetails === 'object' && !Array.isArray(parsedDetails)
        ? { ...parsedDetails }
        : {};
    if (entry.action !== 'balance_credit') return details;

    let asset = typeof details.asset === 'string' ? details.asset : '';
    if (!asset) {
        asset = (Array.isArray(entry.after_wallet) ? entry.after_wallet : [])
            .find((afterBalance) => {
                const beforeBalance = balanceFor(entry.before_wallet, afterBalance?.asset);
                return afterBalance && Number(afterBalance.total) > Number(beforeBalance?.total || 0);
            })?.asset || '';
    }
    const beforeBalance = balanceFor(entry.before_wallet, asset);
    const afterBalance = balanceFor(entry.after_wallet, asset);
    const amount = Number(details.amount);
    const recordedChange = Number(afterBalance?.total) - Number(beforeBalance?.total || 0);
    if (asset) details.asset = asset;
    if ((!Number.isFinite(amount) || amount <= 0) && recordedChange > 0) details.amount = recordedChange;
    details.walletChangeRecorded = recordedChange > 0;
    return details;
}

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
                details: normalizeAuditDetails(entry),
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
