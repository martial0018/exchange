# Telegram activity alerts

The server can send account activity alerts to one Telegram chat. Alerts cover account creation, successful sign-in and sign-out, profile/password changes, account transactions, administrator balance actions, withdrawal requests, and delayed credit/withdrawal completion.

## Create the bot and find the chat ID

1. In Telegram, open the verified **@BotFather** account and send `/newbot`.
2. Follow the prompts to choose a display name and a unique username ending in `bot`.
3. Copy the bot token and keep it private. Do not post it in chat, commit it, or put it in browser screenshots.
4. Open your new bot's private chat and send `/start`.
5. On your own device, open `https://api.telegram.org/bot<TOKEN>/getUpdates`, replacing `<TOKEN>` with the bot token. Find `message.chat.id` in the response; that number is the chat ID. Do not share this URL because it contains the bot token. Clear it from browser history when finished.

## Configure Vercel

In the Vercel dashboard, open the Exchange project, then **Settings → Environment Variables**. Add these variables for **Production**:

- `TELEGRAM_BOT_TOKEN` — the token from BotFather
- `TELEGRAM_CHAT_ID` — the chat ID from `getUpdates`

Save the variables and redeploy the production project so the functions receive them. Send `/start` to the bot before testing. Activity alerts are best effort: a Telegram API/network failure is logged server-side and does not fail or undo the user's account action.

For local development, set the same values in the local process environment. Never commit a `.env` file containing credentials.
