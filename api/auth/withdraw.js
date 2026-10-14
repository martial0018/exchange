const crypto = require('node:crypto');
const {
    getDb,
    handleError,
    methodNotAllowed,
    normalizeUserJsonFields,
    parseBody,
    publicUser,
    requireSameOrigin,
    requireUser,
    sendJson,
    validWallet
} = require('../_lib/http');

function validRequestId(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validWithdrawal(body) {
    return body
        && typeof body === 'object'
        && !Array.isArray(body)
        && Object.keys(body).every((key) => ['requestId', 'asset', 'amount', 'network', 'address'].includes(key))
        && validRequestId(body.requestId)
        && typeof body.asset === 'string'
        && /^[A-Z0-9]{2,20}$/.test(body.asset)
        && Number.isFinite(body.amount)
        && body.amount > 0
        && body.amount <= 1e15
        && typeof body.network === 'string'
        && body.network.trim().length > 0
        && body.network.length <= 80
        && typeof body.address === 'string'
        && body.address.trim().length > 0
        && body.address.length <= 200;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    if (!requireSameOrigin(req, res)) return;
    try {
        const user = await requireUser(req, res, 'user');
        if (!user) return;
        const body = parseBody(req);
        if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 10_000 || !validWithdrawal(body)) {
            return sendJson(res, 400, { error: 'Invalid withdrawal request' });
        }

        const [updatedUser] = await getDb().begin(async (sql) => {
            const [userRow] = await sql`
                SELECT id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                       notifications, balance_jobs, open_orders, order_history, futures_positions,
                       created_at, updated_at, xmin::text AS version
                FROM users
                WHERE id = ${user.id} AND role = 'user'
                FOR UPDATE
            `;
            if (!userRow) return [];
            const currentUser = normalizeUserJsonFields(userRow);
            const existingJob = currentUser.balance_jobs.find((job) => job.requestId === body.requestId);
            if (existingJob) {
                const isSameWithdrawal = existingJob.operation === 'withdrawal'
                    && existingJob.asset === body.asset
                    && existingJob.amount === body.amount
                    && existingJob.network === body.network.trim()
                    && existingJob.address === body.address.trim();
                if (isSameWithdrawal) return [currentUser];
                const error = new Error('This request ID is already associated with a different account action');
                error.status = 409;
                throw error;
            }

            const wallet = JSON.parse(JSON.stringify(currentUser.wallet));
            const balance = wallet.find((entry) => entry.asset === body.asset);
            if (!balance || balance.available < body.amount) {
                const error = new Error(`Insufficient ${body.asset} available balance`);
                error.status = 400;
                throw error;
            }

            balance.available -= body.amount;
            balance.inOrders += body.amount;
            if (!validWallet(wallet)) throw new Error('Withdrawal request produced invalid wallet data');

            const id = crypto.randomUUID();
            const now = Date.now();
            const createdAt = new Date(now).toLocaleString('en-GB');
            const transaction = {
                id,
                time: createdAt,
                type: 'Withdrawal',
                asset: body.asset,
                amount: body.amount,
                side: 'sell',
                network: body.network.trim(),
                address: body.address.trim(),
                status: 'Processing'
            };
            const processingNotificationId = `${id}-processing`;
            const notification = {
                id: processingNotificationId,
                title: 'Withdrawal processing',
                message: `${body.amount.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${body.asset} withdrawal is processing. The amount is reserved from your available balance. This is a simulated withdrawal; no blockchain transfer will be sent.`,
                createdAt,
                read: false
            };
            const job = {
                id,
                requestId: body.requestId,
                asset: body.asset,
                operation: 'withdrawal',
                amount: body.amount,
                transactionId: id,
                processingNotificationId,
                completionNotificationId: `${id}-completed`,
                network: body.network.trim(),
                address: body.address.trim(),
                createdAt: now,
                dueAt: now + 90_000,
                status: 'Processing'
            };

            const [savedUser] = await sql`
                UPDATE users
                SET wallet = ${JSON.stringify(wallet)}::jsonb,
                    transactions = ${JSON.stringify([transaction, ...currentUser.transactions].slice(0, 1000))}::jsonb,
                    notifications = ${JSON.stringify([notification, ...currentUser.notifications].slice(0, 1000))}::jsonb,
                    balance_jobs = ${JSON.stringify([job, ...currentUser.balance_jobs].slice(0, 1000))}::jsonb,
                    updated_at = NOW()
                WHERE id = ${user.id}
                RETURNING id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                          notifications, balance_jobs, open_orders, order_history, futures_positions,
                          created_at, updated_at, xmin::text AS version
            `;
            return [normalizeUserJsonFields(savedUser)];
        });

        if (!updatedUser) return sendJson(res, 404, { error: 'Account not found' });
        sendJson(res, 200, { user: publicUser(updatedUser) });
    } catch (error) {
        if (error.status === 400) return sendJson(res, 400, { error: error.message });
        if (error.status === 409) return sendJson(res, 409, { error: error.message });
        handleError(res, error, 'Unable to submit withdrawal');
    }
};
