const TELEGRAM_API = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 3500;
let warnedMissingConfiguration = false;

function safeText(value, maxLength = 160) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function describeUser(user) {
    const username = safeText(user?.username, 80);
    const id = safeText(user?.id, 80);
    return username ? `@${username} (ID ${id || 'unknown'})` : `User ID ${id || 'unknown'}`;
}

async function sendTelegramActivity(event, user, details = []) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        if (!warnedMissingConfiguration) {
            console.warn('Telegram activity alerts are disabled; configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
            warnedMissingConfiguration = true;
        }
        return false;
    }

    const lines = [
        `Exchange activity: ${safeText(event, 100)}`,
        `User: ${describeUser(user)}`,
        ...details.map((detail) => safeText(detail, 500)).filter(Boolean),
        `Time: ${new Date().toISOString()}`
    ];
    const text = lines.join('\n').slice(0, MAX_MESSAGE_LENGTH);

    try {
        const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                disable_web_page_preview: true
            }),
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) {
            console.error(`Telegram activity alert failed with HTTP ${response.status}.`);
            return false;
        }
        const result = await response.json();
        if (!result.ok) {
            console.error(`Telegram activity alert failed: ${safeText(result.description, 200) || 'Telegram rejected the message'}.`);
            return false;
        }
        return true;
    } catch (error) {
        console.error(`Telegram activity alert could not be delivered (${safeText(error?.name, 40) || 'network error'}).`);
        return false;
    }
}

module.exports = { sendTelegramActivity };
