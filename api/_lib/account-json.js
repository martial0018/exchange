function parseJsonArray(value, field, allowMissing = false) {
    if (value === null || value === undefined) {
        if (allowMissing) {
            console.warn(`Missing stored ${field} data; initializing it as an empty array.`);
            return [];
        }
        throw new Error(`Missing stored ${field} data`);
    }
    let parsed = value;
    while (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch (error) {
            throw new Error(`Invalid stored ${field} data`, { cause: error });
        }
    }
    if (!Array.isArray(parsed)) throw new Error(`Invalid stored ${field} data`);
    return parsed;
}

function normalizeUserJsonFields(user) {
    return {
        ...user,
        wallet: parseJsonArray(user.wallet, 'Spot wallet'),
        funding_wallet: parseJsonArray(user.funding_wallet, 'Funding wallet', true),
        futures_wallet: parseJsonArray(user.futures_wallet, 'Futures wallet', true),
        transactions: parseJsonArray(user.transactions, 'transactions', true),
        notifications: parseJsonArray(user.notifications, 'notifications', true),
        balance_jobs: parseJsonArray(user.balance_jobs, 'balance jobs', true),
        open_orders: parseJsonArray(user.open_orders, 'open orders', true),
        order_history: parseJsonArray(user.order_history, 'order history', true),
        futures_positions: parseJsonArray(user.futures_positions, 'futures positions', true)
    };
}

module.exports = { normalizeUserJsonFields, parseJsonArray };
