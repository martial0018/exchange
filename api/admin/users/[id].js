const crypto = require('node:crypto');
const { getDb, handleError, methodNotAllowed, parseBody, publicUser, requireSameOrigin, requireUser, sendJson, validWallet } = require('../../_lib/http');

const DEFAULT_WALLET = [
    { asset: 'BTC', total: 0.2441, available: 0.2441, inOrders: 0 },
    { asset: 'USDT', total: 10000, available: 10000, inOrders: 0 },
    { asset: 'ETH', total: 1.3425, available: 1.3425, inOrders: 0 }
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
        status: 'Completed (practice)',
        adminUsername: actor.username
    };
    if (action === 'balance_credit') {
        return {
            ...common,
            type: 'Practice Deposit',
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
            details: 'Reset to the default practice wallet'
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
                const [existingUser] = await sql`
                    SELECT id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                           notifications, balance_jobs, open_orders, order_history, futures_positions,
                           created_at, updated_at
                    FROM users WHERE id = ${existingAction.target_user_id}
                `;
                return existingUser ? [{ user: existingUser, duplicate: true }] : [];
            }

            const [user] = await sql`
                SELECT id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                       notifications, balance_jobs, open_orders, order_history, futures_positions,
                       created_at, updated_at
                FROM users
                WHERE id = ${userId} AND role = 'user'
                FOR UPDATE
            `;
            if (!user) return [];

            const beforeWallet = Array.isArray(user.wallet) ? user.wallet : [];
            const afterWallet = JSON.parse(JSON.stringify(beforeWallet));
            let details;
            if (body.action === 'wallet_reset') {
                afterWallet.splice(0, afterWallet.length, ...DEFAULT_WALLET);
                details = { description: 'Reset to default practice wallet' };
            } else {
                let balance = afterWallet.find((entry) => entry.asset === body.asset);
                if (!balance && body.action === 'balance_credit') {
                    balance = { asset: body.asset, total: 0, available: 0, inOrders: 0 };
                    afterWallet.push(balance);
                }
                if (!balance) return [];
                if (body.action === 'balance_credit') {
                    balance.total += body.amount;
                    balance.available += body.amount;
                    details = {
                        asset: body.asset,
                        amount: body.amount,
                        network: body.network.trim(),
                        fromAddress: body.fromAddress.trim()
                    };
                } else {
                    balance.total = body.total;
                    balance.available = body.available;
                    balance.inOrders = body.inOrders;
                    details = { asset: body.asset, total: body.total, available: body.available, inOrders: body.inOrders };
                }
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
            const notifications = [{
                id: `${id}-completed`,
                title: 'Balance transaction completed',
                message: body.action === 'wallet_reset'
                    ? 'Your practice wallet reset has completed.'
                    : body.action === 'balance_credit'
                        ? `${body.amount.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${body.asset} has been credited to your practice account.`
                        : `Your ${body.asset} practice balance was updated by an administrator.`,
                createdAt: now.toLocaleString('en-GB'),
                read: false
            }, ...(Array.isArray(user.notifications) ? user.notifications : [])].slice(0, 1000);
            const balanceJobs = [{
                id,
                asset: body.action === 'wallet_reset' ? 'WALLET' : body.asset,
                operation: body.action === 'wallet_reset' ? 'setWallet' : body.action === 'balance_credit' ? 'credit' : 'set',
                amount: body.action === 'balance_credit' ? body.amount : 0,
                transactionId: id,
                status: 'Completed',
                completedAt: now.getTime()
            }, ...(Array.isArray(user.balance_jobs) ? user.balance_jobs : [])].slice(0, 1000);

            const [updatedUser] = await sql`
                UPDATE users
                SET wallet = ${JSON.stringify(afterWallet)}::jsonb,
                    transactions = ${JSON.stringify(transactions)}::jsonb,
                    notifications = ${JSON.stringify(notifications)}::jsonb,
                    balance_jobs = ${JSON.stringify(balanceJobs)}::jsonb,
                    updated_at = NOW()
                WHERE id = ${userId}
                RETURNING id, username, email, full_name, role, wallet, funding_wallet, futures_wallet, transactions,
                          notifications, balance_jobs, open_orders, order_history, futures_positions,
                          created_at, updated_at
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
        sendJson(res, 200, { user: publicUser(result.user), duplicate: result.duplicate });
    } catch (error) {
        handleError(res, error, 'Unable to save administrator action');
    }
};
