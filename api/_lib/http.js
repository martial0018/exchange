const crypto = require('node:crypto');
const { getDb } = require('./db');

const SESSION_COOKIE = '__Host-exchange_session';
const SESSION_DURATION_SECONDS = 60 * 60 * 12;

function sendJson(res, status, body, headers = {}) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    Object.entries(headers).forEach(([name, value]) => res.setHeader(name, value));
    res.end(JSON.stringify(body));
}

function methodNotAllowed(res, allowed) {
    res.setHeader('Allow', allowed.join(', '));
    sendJson(res, 405, { error: 'Method not allowed' });
}

function parseBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') return JSON.parse(req.body);
    return {};
}

function requireSameOrigin(req, res) {
    const origin = req.headers.origin;
    if (!origin) {
        sendJson(res, 403, { error: 'A same-origin request is required' });
        return false;
    }
    let expectedOrigin = process.env.APP_ORIGIN;
    if (!expectedOrigin) {
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        expectedOrigin = host ? `${protocol}://${host}` : '';
    }
    try {
        if (new URL(origin).origin !== new URL(expectedOrigin).origin) {
            sendJson(res, 403, { error: 'A same-origin request is required' });
            return false;
        }
    } catch (error) {
        console.error('Unable to validate request origin.', error);
        sendJson(res, 403, { error: 'A same-origin request is required' });
        return false;
    }
    return true;
}

function setSessionCookie(res, token) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION_SECONDS}`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

function sessionToken(req) {
    const cookie = req.headers.cookie || '';
    const entry = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    return entry ? entry.slice(SESSION_COOKIE.length + 1) : '';
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(userId, res) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000);
    await getDb()`
        INSERT INTO sessions (token_hash, user_id, expires_at)
        VALUES (${hashToken(token)}, ${userId}, ${expiresAt})
    `;
    setSessionCookie(res, token);
}

async function getSessionUser(req) {
    const token = sessionToken(req);
    if (!token) return null;
    const [user] = await getDb()`
        SELECT u.id, u.username, u.email, u.full_name, u.role, u.wallet, u.funding_wallet, u.futures_wallet,
               u.transactions, u.notifications, u.balance_jobs, u.open_orders,
               u.order_history, u.futures_positions, u.created_at, u.updated_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > NOW()
        LIMIT 1
    `;
    return user || null;
}

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        wallet: user.wallet,
        fundingWallet: user.funding_wallet,
        futuresWallet: user.futures_wallet,
        transactions: user.transactions,
        notifications: user.notifications,
        balanceJobs: user.balance_jobs,
        openOrders: user.open_orders,
        orderHistory: user.order_history,
        futuresPositions: user.futures_positions,
        createdAt: user.created_at,
        updatedAt: user.updated_at
    };
}

async function requireUser(req, res, requiredRole) {
    const user = await getSessionUser(req);
    if (!user) {
        sendJson(res, 401, { error: 'Sign in to continue' });
        return null;
    }
    if (requiredRole && user.role !== requiredRole) {
        sendJson(res, 403, { error: 'Administrator access is required' });
        return null;
    }
    return user;
}

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16);
        crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
            if (error) return reject(error);
            resolve(`scrypt$${salt.toString('hex')}$${key.toString('hex')}`);
        });
    });
}

function verifyPassword(password, stored) {
    const [scheme, saltHex, keyHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(keyHex)) {
        return Promise.resolve(false);
    }
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
            if (error) return reject(error);
            resolve(crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex')));
        });
    });
}

function validWallet(wallet) {
    return Array.isArray(wallet)
        && wallet.length <= 100
        && wallet.every((balance) => balance
            && typeof balance.asset === 'string'
            && /^[A-Z0-9]{2,20}$/.test(balance.asset)
            && ['total', 'available', 'inOrders'].every((field) => Number.isFinite(balance[field]) && balance[field] >= 0)
            && balance.total >= balance.available + balance.inOrders);
}

function handleError(res, error, message = 'The request could not be completed') {
    console.error(message, error);
    if (error && error.message === 'DATABASE_URL is not configured') {
        sendJson(res, 503, { error: 'Account service is not configured yet. Please try again later.' });
        return;
    }
    if (error && error.code === '23505') {
        sendJson(res, 409, { error: 'An account with those details already exists' });
        return;
    }
    sendJson(res, 500, { error: message });
}

module.exports = {
    clearSessionCookie,
    createSession,
    getDb,
    getSessionUser,
    handleError,
    hashPassword,
    methodNotAllowed,
    parseBody,
    publicUser,
    requireSameOrigin,
    requireUser,
    sendJson,
    setSessionCookie,
    validWallet,
    verifyPassword
};
