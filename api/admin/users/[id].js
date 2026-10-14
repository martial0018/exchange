const crypto = require('node:crypto');
const { getDb, handleError, methodNotAllowed, normalizeUserJsonFields, parseBody, publicUser, requireSameOrigin, requireUser, sendJson, validWallet } = require('../../_lib/http');
const { sendTelegramActivity } = require('../../_lib/telegram-alerts');

const DEFAULT_WALLET = [
    { asset: 'BTC', total: 0, available: 0, inOrders: 0 },
    { asset: 'USDT', total: 0, available: 0, inOrders: 0 },
    { asset: 'ETH', total: 0, available: 0, inOrders: 0 }
];

function validAmount(value, allowZero = false) {
    return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && value <= 1e15;
}

function validRequestId(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validActionBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !validRequestId(body.requestId)) return false;
    if (body.action === 'balance_adjustment') {
        return Object.keys(body).every((key) => ['action', 'requestId', 'asset', 'total', 'available', 'inOrders'].includes(key))
            && typeof body.asset === 'string'
            && /^[A-Z0-9]{2,20}$/.test(body.asset)
            && ['total', 'available', 'inOrders'].every((key) => validAmount(body[key], true))
            && body.total >= body.available + body.inOrders;
    }
    if (body.action === 'balance_credit') {
        return Object.keys(body).every((key) => ['action', 'requestId', 'asset', 'amount', 'network', 'fromAddress'].includes(key))
            && typeof body.asset === 'string'
            && /^[A-Z0-9]{2,20}$/.test(body.asset)
            && validAmount(body.amount)
            && typeof body.network === 'string'
            && body.network.trim().length > 0
            && body.network.length <= 80
            && typeof body.fromAddress === 'string'
            && body.fromAddress.trim().length > 0
            && body.fromAddress.length <= 200;
    }
    return body.action === 'wallet_reset'
        && Object.keys(body).every((key) => ['action', 'requestId'].includes(key));
}

function createTransaction({ id, action, actor, body, now, beforeWallet, afterWallet }) {
    const common = {
        id,
        time: now.toLocaleString('en-GB'),
        status: action === 'balance_credit' ? 'Processing' : 'Completed (simulated)',
        adminUsername: actor.username
    };
    if (action === 'balance_credit') {
        return {
            ...common,
            type: 'Balance Credit',
            asset: body.asset,
            amount: body.amount,
            side: 'buy',
            network: body.network.trim(),
            fromAddress: body.fromAddress.trim()
        };
    }
    if (action === 'wallet_reset') {
        return {
            ...common,
            type: 'Admin Wallet Reset',
            asset: 'WALLET',
            amount: 0,
            details: 'Reset to the zero-balance wallet'
        };
    }
    const oldBalance = beforeWallet.find((entry) => entry.asset === body.asset);
    const newBalance = afterWallet.find((entry) => entry.asset === body.asset);
    const delta = newBalance.total - oldBalance.total;
    return {
        ...common,
        type: delta === 0 ? 'Admin Balance Allocation Update' : 'Admin Balance Adjustment',
        asset: body.asset,
        amount: Math.abs(delta),
        side: delta >= 0 ? 'buy' : 'sell',
        details: `Total ${oldBalance.total} -> ${newBalance.total}; available ${oldBalance.available} -> ${newBalance.available}; in orders ${oldBalance.inOrders} -> ${newBalance.inOrders}`
    };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    if (!requireSameOrigin(req, res)) return;
    try {
        const admin = await requireUser(req, res, 'admin');
        if (!admin) return;

        const userId = Number(req.query?.id);
        if (!Number.isSafeInteger(userId) || userId <= 0) return sendJson(res, 400, { error: 'Invalid account ID' });

        const body = parseBody(req);
        if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 10_000 || !validActionBody(body)) {
            return sendJson(res, 400, { error: 'Invalid administrator action' });
        }

        const [result] = await getDb().begin(async (sql) => {
            const [existingAction] = await sql`
                SELECT target_user_id FROM admin_audit_log
                WHERE actor_id = ${admin.id} AND request_id = ${body.requestId}
            `;
            if (existingAction) {
                const [existingUserRow] = await sql`
                    SELECT id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                           notifications, balance_jobs, open_orders, order_history, futures_positions,
                           created_at, updated_at, xmin::text AS version
                    FROM users WHERE id = ${existingAction.target_user_id}
                `;
                const existingUser = existingUserRow ? normalizeUserJsonFields(existingUserRow) : null;
                return existingUser ? [{ user: existingUser, duplicate: true }] : [];
            }

            const [userRow] = await sql`
                SELECT id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                       notifications, balance_jobs, open_orders, order_history, futures_positions,
                       created_at, updated_at, xmin::text AS version
                FROM users
                WHERE id = ${userId} AND role = 'user'
                FOR UPDATE
            `;
            const user = userRow ? normalizeUserJsonFields(userRow) : null;
            if (!user) return [];

            const beforeWallet = Array.isArray(user.wallet) ? user.wallet : [];
            const afterWallet = JSON.parse(JSON.stringify(beforeWallet));
            const walletReset = body.action === 'wallet_reset';
            const openOrders = walletReset ? [] : Array.isArray(user.open_orders) ? user.open_orders : [];
            const orderHistory = (Array.isArray(user.order_history) ? user.order_history : []).map((order) =>
                walletReset && (Array.isArray(user.open_orders) ? user.open_orders : []).some((openOrder) => openOrder.id === order.id)
                    ? { ...order, status: 'Canceled' }
                    : order
            );
            let details;
            if (walletReset) {
                afterWallet.splice(0, afterWallet.length, ...DEFAULT_WALLET);
                details = { description: 'Reset to zero-balance wallet' };
            } else if (body.action === 'balance_credit') {
                details = {
                    asset: body.asset,
                    amount: body.amount,
                    network: body.network.trim(),
                    fromAddress: body.fromAddress.trim(),
                    status: 'Processing',
                    walletChangeRecorded: false
                };
            } else {
                let balance = afterWallet.find((entry) => entry.asset === body.asset);
                if (!balance) return [];
                balance.total = body.total;
                balance.available = body.available;
                balance.inOrders = body.inOrders;
                details = { asset: body.asset, total: body.total, available: body.available, inOrders: body.inOrders };
            }
            if (!validWallet(afterWallet)) throw new Error('Administrator action produced invalid wallet data');

            const id = crypto.randomUUID();
            const now = new Date();
            const transaction = createTransaction({
                id,
                action: body.action,
                actor: admin,
                body,
                now,
                beforeWallet,
                afterWallet
            });
            const transactions = [transaction, ...(Array.isArray(user.transactions) ? user.transactions : [])].slice(0, 1000);
            const processingCredit = body.action === 'balance_credit';
            const notifications = [{
                id: processingCredit ? `${id}-processing` : `${id}-completed`,
                title: processingCredit ? 'Balance transaction processing' : 'Balance transaction completed',
                message: body.action === 'wallet_reset'
                    ? 'Your wallet reset has completed.'
                    : processingCredit
                        ? `${body.amount.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${body.asset} credit is processing. It will be added to your Spot balance when processing completes.`
                        : `Your ${body.asset} balance was updated by an administrator.`,
                createdAt: now.toLocaleString('en-GB'),
                read: false
            }, ...(Array.isArray(user.notifications) ? user.notifications : [])].slice(0, 1000);
            const balanceJobs = [{
                id,
                asset: body.action === 'wallet_reset' ? 'WALLET' : body.asset,
                operation: body.action === 'wallet_reset' ? 'setWallet' : body.action === 'balance_credit' ? 'credit' : 'set',
                amount: body.action === 'balance_credit' ? body.amount : 0,
                transactionId: id,
                processingNotificationId: processingCredit ? `${id}-processing` : undefined,
                completionNotificationId: processingCredit ? `${id}-completed` : undefined,
                auditRequestId: processingCredit ? body.requestId : undefined,
                createdAt: now.getTime(),
                dueAt: processingCredit ? now.getTime() + 90_000 : undefined,
                status: processingCredit ? 'Processing' : 'Completed',
                completedAt: processingCredit ? undefined : now.getTime()
            }, ...(Array.isArray(user.balance_jobs) ? user.balance_jobs : [])].slice(0, 1000);

            const [updatedUser] = await sql`
                UPDATE users
                SET wallet = ${JSON.stringify(afterWallet)}::jsonb,
                    funding_wallet = ${JSON.stringify(walletReset ? [] : user.funding_wallet || [])}::jsonb,
                    futures_wallet = ${JSON.stringify(walletReset ? [] : user.futures_wallet || [])}::jsonb,
                    open_orders = ${JSON.stringify(openOrders)}::jsonb,
                    order_history = ${JSON.stringify(orderHistory)}::jsonb,
                    futures_positions = ${JSON.stringify(walletReset ? [] : user.futures_positions || [])}::jsonb,
                    transactions = ${JSON.stringify(transactions)}::jsonb,
                    notifications = ${JSON.stringify(notifications)}::jsonb,
                    balance_jobs = ${JSON.stringify(balanceJobs)}::jsonb,
                    updated_at = NOW()
                WHERE id = ${userId}
                RETURNING id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                          notifications, balance_jobs, open_orders, order_history, futures_positions,
                          created_at, updated_at, xmin::text AS version
            `;
            await sql`
                INSERT INTO admin_audit_log (actor_id, target_user_id, action, before_wallet, after_wallet, details, request_id)
                VALUES (
                    ${admin.id},
                    ${userId},
                    ${body.action},
                    ${JSON.stringify(beforeWallet)}::jsonb,
                    ${JSON.stringify(afterWallet)}::jsonb,
                    ${JSON.stringify(details)}::jsonb,
                    ${body.requestId}
                )
            `;
            return [{ user: updatedUser, duplicate: false }];
        });

        if (!result) return sendJson(res, 404, { error: 'Account not found or balance asset is unavailable' });
        if (!result.duplicate) {
            const actionName = {
                balance_credit: 'Admin credited account balance',
                balance_adjustment: 'Admin adjusted account balance',
                wallet_reset: 'Admin reset account wallet'
            }[body.action] || 'Admin updated account';
            const details = [`Action by: @${admin.username}`];
            if (body.asset) details.push(`Asset: ${body.asset}`);
            if (Number.isFinite(body.amount)) {
                details.push(`Amount: ${body.amount.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${body.asset}`);
            }
            if (body.network) details.push(`Network: ${body.network}`);
            details.push(body.action === 'balance_credit' ? 'Status: Processing' : 'Status: Completed');
            await sendTelegramActivity(actionName, result.user, details);
        }
        sendJson(res, 200, { user: publicUser(result.user), duplicate: result.duplicate });
    } catch (error) {
        handleError(res, error, 'Unable to save administrator action');
    }
};
