const { getDb, handleError, methodNotAllowed, publicUser, requireUser, sendJson } = require('../../_lib/http');
const { completeDueBalanceJobs } = require('../../_lib/balance-jobs');
const { normalizeUserJsonFields } = require('../../_lib/account-json');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    try {
        const admin = await requireUser(req, res, 'admin');
        if (!admin) return;
        const users = await getDb()`
            SELECT id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                   notifications, balance_jobs, open_orders, order_history, futures_positions,
                   created_at, updated_at, xmin::text AS version
            FROM users
            WHERE role = 'user'
            ORDER BY created_at DESC
            LIMIT 1000
        `;
        const normalizedUsers = users.map(normalizeUserJsonFields);
        const dueUserIds = normalizedUsers
            .filter((user) => user.balance_jobs.some((job) =>
                ['credit', 'withdrawal'].includes(job.operation)
                && job.status === 'Processing'
                && Number.isFinite(job.dueAt)
                && job.dueAt <= Date.now()
            ))
            .map((user) => user.id);
        const completedUsers = new Map(
            (await Promise.all(dueUserIds.map((userId) => completeDueBalanceJobs(userId))))
                .filter(Boolean)
                .map((user) => [String(user.id), user])
        );
        sendJson(res, 200, {
            users: normalizedUsers.map((user) => publicUser(completedUsers.get(String(user.id)) || user))
        });
    } catch (error) {
        handleError(res, error, 'Unable to load registered accounts');
    }
};
