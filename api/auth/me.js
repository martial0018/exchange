const crypto = require('node:crypto');
const {
    clearSessionCookie,
    getDb,
    getSessionUser,
    handleError,
    methodNotAllowed,
    normalizeUserJsonFields,
    parseBody,
    publicUser,
    requireSameOrigin,
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
    try {
        if (req.method === 'POST') {
            if (!requireSameOrigin(req, res)) return;
            const user = await getSessionUser(req);
            if (!user) return sendJson(res, 401, { error: 'Sign in to continue' });
            if (user.role !== 'user') return sendJson(res, 403, { error: 'User account access is required' });
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
            return sendJson(res, 200, { user: publicUser(updatedUser) });
        }
        if (req.method === 'GET') {
            const user = await getSessionUser(req);
            return user ? sendJson(res, 200, { user: publicUser(user) }) : sendJson(res, 401, { error: 'Not signed in' });
        }
        if (req.method === 'DELETE') {
            if (!requireSameOrigin(req, res)) return;
            const token = (req.headers.cookie || '').split(';')
                .map((part) => part.trim())
                .find((part) => part.startsWith('__Host-exchange_session='))
                ?.slice('__Host-exchange_session='.length);
            if (token) {
                const crypto = require('node:crypto');
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                await getDb()`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
            }
            clearSessionCookie(res);
            return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'PUT') {
            if (!requireSameOrigin(req, res)) return;
            const user = await getSessionUser(req);
            if (!user) return sendJson(res, 401, { error: 'Sign in to continue' });
            const body = parseBody(req);
            if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 200_000) {
                return sendJson(res, 413, { error: 'Account update is too large' });
            }
            const allowed = ['version', 'wallet', 'fundingWallet', 'futuresWallet', 'transactions', 'notifications', 'openOrders', 'orderHistory', 'futuresPositions'];
            if (Object.keys(body).some((key) => !allowed.includes(key))) {
                return sendJson(res, 400, { error: 'Unsupported account data field' });
            }
            if (typeof body.version !== 'string' || !/^\d+$/.test(body.version)) {
                return sendJson(res, 428, { error: 'Your account data is out of date. Refresh before saving.' });
            }
            for (const field of ['wallet', 'fundingWallet', 'futuresWallet']) {
                if (body[field] !== undefined && !validWallet(body[field])) {
                    const walletName = { wallet: 'Spot wallet', fundingWallet: 'Funding wallet', futuresWallet: 'Futures wallet' }[field];
                    return sendJson(res, 400, { error: `Invalid ${walletName} data` });
                }
            }
            const jsonFields = [
                ['transactions', 'transactions'],
                ['notifications', 'notifications'],
                ['openOrders', 'open orders'],
                ['orderHistory', 'order history'],
                ['futuresPositions', 'futures positions']
            ];
            for (const [field, label] of jsonFields) {
                if (body[field] !== undefined && (!Array.isArray(body[field]) || body[field].length > 1000)) {
                    return sendJson(res, 400, { error: `Invalid ${label} data` });
                }
            }
            const [freshUser] = await getDb()`
                UPDATE users SET
                    wallet = COALESCE(${body.wallet === undefined ? null : JSON.stringify(body.wallet)}::jsonb, wallet),
                    funding_wallet = COALESCE(${body.fundingWallet === undefined ? null : JSON.stringify(body.fundingWallet)}::jsonb, funding_wallet),
                    futures_wallet = COALESCE(${body.futuresWallet === undefined ? null : JSON.stringify(body.futuresWallet)}::jsonb, futures_wallet),
                    transactions = COALESCE(${body.transactions === undefined ? null : JSON.stringify(body.transactions)}::jsonb, transactions),
                    notifications = COALESCE(${body.notifications === undefined ? null : JSON.stringify(body.notifications)}::jsonb, notifications),
                    open_orders = COALESCE(${body.openOrders === undefined ? null : JSON.stringify(body.openOrders)}::jsonb, open_orders),
                    order_history = COALESCE(${body.orderHistory === undefined ? null : JSON.stringify(body.orderHistory)}::jsonb, order_history),
                    futures_positions = COALESCE(${body.futuresPositions === undefined ? null : JSON.stringify(body.futuresPositions)}::jsonb, futures_positions),
                    updated_at = NOW()
                WHERE id = ${user.id} AND xmin::text = ${body.version}
                RETURNING id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                       notifications, balance_jobs, open_orders, order_history, futures_positions,
                       created_at, updated_at, xmin::text AS version
            `;
            if (!freshUser) {
                const [latestUser] = await getDb()`
                    SELECT id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                           notifications, balance_jobs, open_orders, order_history, futures_positions,
                           created_at, updated_at, xmin::text AS version
                    FROM users WHERE id = ${user.id}
                `;
                if (!latestUser) return sendJson(res, 404, { error: 'Account not found' });
                return sendJson(res, 409, {
                    error: 'Your account changed elsewhere. The latest balance and account data have been refreshed.',
                    user: publicUser(latestUser)
                });
            }
            return sendJson(res, 200, { user: publicUser(freshUser) });
        }
        return methodNotAllowed(res, ['GET', 'POST', 'PUT', 'DELETE']);
    } catch (error) {
        if (error.status === 400 || error.status === 409) {
            return sendJson(res, error.status, { error: error.message });
        }
        handleError(res, error, 'Unable to access account');
    }
};
