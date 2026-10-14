const { getDb } = require('./db');
const { normalizeUserJsonFields } = require('./account-json');
const { sendTelegramActivity } = require('./telegram-alerts');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function formatAmount(value) {
    return Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

async function completeDueBalanceJobs(userId) {
    const completedJobs = [];
    const user = await getDb().begin(async (sql) => {
        const [userRow] = await sql`
            SELECT id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                   notifications, balance_jobs, open_orders, order_history, futures_positions,
                   created_at, updated_at, xmin::text AS version
            FROM users
            WHERE id = ${userId}
            FOR UPDATE
        `;
        if (!userRow) return null;

        const user = normalizeUserJsonFields(userRow);
        const now = Date.now();
        const dueJobs = user.balance_jobs.filter((job) =>
            ['credit', 'withdrawal'].includes(job.operation)
            && job.status === 'Processing'
            && Number.isFinite(job.dueAt)
            && job.dueAt <= now
        );
        if (!dueJobs.length) return user;

        const wallet = clone(user.wallet);
        const transactions = clone(user.transactions);
        const notifications = clone(user.notifications);
        const balanceJobs = clone(user.balance_jobs);

        for (const dueJob of dueJobs) {
            completedJobs.push(dueJob);
            let balance = wallet.find((entry) => entry.asset === dueJob.asset);
            if (!balance) {
                balance = { asset: dueJob.asset, total: 0, available: 0, inOrders: 0 };
                wallet.push(balance);
            }
            if (dueJob.operation === 'withdrawal') {
                balance.total -= dueJob.amount;
                balance.inOrders -= dueJob.amount;
            } else {
                balance.total += dueJob.amount;
                balance.available += dueJob.amount;
            }

            const transaction = transactions.find((entry) => entry.id === dueJob.transactionId);
            if (transaction) {
                transaction.status = 'Completed (practice)';
                transaction.completedAt = new Date(now).toLocaleString('en-GB');
            }

            const job = balanceJobs.find((entry) => entry.id === dueJob.id);
            if (job) {
                job.status = 'Completed';
                job.completedAt = now;
            }

            notifications.unshift({
                id: dueJob.completionNotificationId || `${dueJob.id}-completed`,
                title: dueJob.operation === 'withdrawal' ? 'Withdrawal completed' : 'Balance transaction completed',
                message: dueJob.operation === 'withdrawal'
                    ? `Your simulated withdrawal of ${formatAmount(dueJob.amount)} ${dueJob.asset} has completed. No blockchain transfer was sent.`
                    : `${formatAmount(dueJob.amount)} ${dueJob.asset} has been credited to your practice account.`,
                createdAt: new Date(now).toLocaleString('en-GB'),
                read: false
            });

            if (dueJob.operation === 'credit' && dueJob.auditRequestId) {
                await sql`
                    UPDATE admin_audit_log
                    SET after_wallet = ${JSON.stringify(wallet)}::jsonb,
                        details = details || ${JSON.stringify({ walletChangeRecorded: true, status: 'Completed' })}::jsonb
                    WHERE target_user_id = ${user.id} AND request_id = ${dueJob.auditRequestId}
                `;
            }
        }

        const [updatedUser] = await sql`
            UPDATE users
            SET wallet = ${JSON.stringify(wallet)}::jsonb,
                transactions = ${JSON.stringify(transactions.slice(0, 1000))}::jsonb,
                notifications = ${JSON.stringify(notifications.slice(0, 1000))}::jsonb,
                balance_jobs = ${JSON.stringify(balanceJobs.slice(0, 1000))}::jsonb,
                updated_at = NOW()
            WHERE id = ${user.id}
            RETURNING id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                      notifications, balance_jobs, open_orders, order_history, futures_positions,
                      created_at, updated_at, xmin::text AS version
        `;
        return normalizeUserJsonFields(updatedUser);
    });
    if (user && completedJobs.length) {
        const details = completedJobs.slice(0, 8).map((job) => {
            const action = job.operation === 'withdrawal' ? 'Withdrawal' : 'Balance credit';
            return `${action}: ${formatAmount(job.amount)} ${job.asset} completed (simulated practice balance)`;
        });
        if (completedJobs.length > details.length) details.push(`${completedJobs.length - details.length} more completed operation(s)`);
        await sendTelegramActivity(
            completedJobs.length === 1 ? 'Account balance operation completed' : `${completedJobs.length} account balance operations completed`,
            user,
            details
        );
    }
    return user;
}

module.exports = { completeDueBalanceJobs };
