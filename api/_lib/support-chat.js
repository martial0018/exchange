const {
    getDb,
    handleError,
    methodNotAllowed,
    parseBody,
    requireSameOrigin,
    requireUser,
    sendJson
} = require('./http');

const MAX_MESSAGE_LENGTH = 2000;

function messageData(message) {
    return {
        id: String(message.id),
        senderRole: message.sender_role,
        senderName: message.sender_name,
        body: message.body,
        createdAt: message.created_at
    };
}

async function loadMessages(threadId) {
    const messages = await getDb()`
        SELECT message.id, message.sender_role, message.body, message.created_at,
               user_account.username AS sender_name
        FROM support_messages message
        JOIN users user_account ON user_account.id = message.sender_id
        WHERE message.thread_id = ${threadId}
        ORDER BY message.created_at, message.id
        LIMIT 500
    `;
    return messages.map(messageData);
}

module.exports = async function handler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
    if (req.method === 'POST' && !requireSameOrigin(req, res)) return;

    try {
        const user = await requireUser(req, res);
        if (!user) return;
        const db = getDb();
        const requestUrl = new URL(req.url, 'https://exchange.invalid');
        const requestedThreadId = requestUrl.searchParams.get('threadId');
        const isAdmin = user.role === 'admin';

        if (req.method === 'GET') {
            if (!isAdmin) {
                const [thread] = await db`
                    SELECT id, status, created_at, updated_at
                    FROM support_threads
                    WHERE user_id = ${user.id}
                    ORDER BY updated_at DESC, id DESC
                    LIMIT 1
                `;
                if (!thread) return sendJson(res, 200, { thread: null, messages: [] });
                return sendJson(res, 200, {
                    thread: { id: String(thread.id), status: thread.status, createdAt: thread.created_at, updatedAt: thread.updated_at },
                    messages: await loadMessages(thread.id)
                });
            }

            if (!requestedThreadId) {
                const threads = await db`
                    SELECT thread.id, thread.status, thread.created_at, thread.updated_at,
                           user_account.id AS user_id, user_account.username, user_account.full_name,
                           latest.body AS last_message, latest.sender_role AS last_sender_role,
                           latest.created_at AS last_message_at
                    FROM support_threads thread
                    JOIN users user_account ON user_account.id = thread.user_id
                    LEFT JOIN LATERAL (
                        SELECT body, sender_role, created_at
                        FROM support_messages
                        WHERE thread_id = thread.id
                        ORDER BY created_at DESC, id DESC
                        LIMIT 1
                    ) latest ON TRUE
                    ORDER BY thread.updated_at DESC, thread.id DESC
                    LIMIT 100
                `;
                return sendJson(res, 200, {
                    threads: threads.map((thread) => ({
                        id: String(thread.id),
                        status: thread.status,
                        userId: String(thread.user_id),
                        username: thread.username,
                        fullName: thread.full_name,
                        lastMessage: thread.last_message || '',
                        lastSenderRole: thread.last_sender_role || '',
                        lastMessageAt: thread.last_message_at || thread.updated_at
                    }))
                });
            }

            if (!/^[1-9]\d{0,18}$/.test(requestedThreadId)) {
                return sendJson(res, 400, { error: 'Invalid support conversation' });
            }
            const [thread] = await db`
                SELECT thread.id, thread.status, thread.created_at, thread.updated_at,
                       user_account.id AS user_id, user_account.username, user_account.full_name
                FROM support_threads thread
                JOIN users user_account ON user_account.id = thread.user_id
                WHERE thread.id = ${requestedThreadId}
                LIMIT 1
            `;
            if (!thread) return sendJson(res, 404, { error: 'Support conversation not found' });
            return sendJson(res, 200, {
                thread: {
                    id: String(thread.id),
                    status: thread.status,
                    userId: String(thread.user_id),
                    username: thread.username,
                    fullName: thread.full_name,
                    createdAt: thread.created_at,
                    updatedAt: thread.updated_at
                },
                messages: await loadMessages(thread.id)
            });
        }

        const { message, threadId } = parseBody(req);
        if (typeof message !== 'string' || !message.trim() || message.trim().length > MAX_MESSAGE_LENGTH) {
            return sendJson(res, 400, { error: `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters` });
        }
        const body = message.trim();
        if (isAdmin) {
            if (typeof threadId !== 'string' && typeof threadId !== 'number') {
                return sendJson(res, 400, { error: 'Select a support conversation before replying' });
            }
            const validThreadId = String(threadId);
            if (!/^[1-9]\d{0,18}$/.test(validThreadId)) {
                return sendJson(res, 400, { error: 'Invalid support conversation' });
            }
            const [created] = await db.begin(async (sql) => {
                const [thread] = await sql`
                    SELECT id FROM support_threads WHERE id = ${validThreadId} AND status = 'open' FOR UPDATE
                `;
                if (!thread) return [];
                const [savedMessage] = await sql`
                    INSERT INTO support_messages (thread_id, sender_id, sender_role, body)
                    VALUES (${thread.id}, ${user.id}, 'admin', ${body})
                    RETURNING id, sender_role, body, created_at
                `;
                await sql`UPDATE support_threads SET updated_at = NOW() WHERE id = ${thread.id}`;
                return [{ ...savedMessage, sender_name: user.username }];
            });
            if (!created) return sendJson(res, 404, { error: 'Open support conversation not found' });
            return sendJson(res, 201, { message: messageData(created) });
        }

        const [created] = await db.begin(async (sql) => {
            await sql`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
            let [thread] = await sql`
                SELECT id FROM support_threads
                WHERE user_id = ${user.id} AND status = 'open'
                ORDER BY id DESC LIMIT 1
            `;
            if (!thread) {
                [thread] = await sql`
                    INSERT INTO support_threads (user_id)
                    VALUES (${user.id})
                    RETURNING id
                `;
            }
            const [recent] = await sql`
                SELECT COUNT(*)::int AS count FROM support_messages
                WHERE thread_id = ${thread.id} AND sender_id = ${user.id}
                  AND created_at > NOW() - INTERVAL '1 minute'
            `;
            if (recent.count >= 20) return [];
            const [savedMessage] = await sql`
                INSERT INTO support_messages (thread_id, sender_id, sender_role, body)
                VALUES (${thread.id}, ${user.id}, 'user', ${body})
                RETURNING id, sender_role, body, created_at
            `;
            await sql`UPDATE support_threads SET updated_at = NOW() WHERE id = ${thread.id}`;
            return [{ thread_id: thread.id, ...savedMessage, sender_name: user.username }];
        });
        if (!created) return sendJson(res, 429, { error: 'Please wait a minute before sending more messages' });
        return sendJson(res, 201, {
            threadId: String(created.thread_id),
            message: messageData(created)
        });
    } catch (error) {
        handleError(res, error, 'Unable to process the support chat request');
    }
};
