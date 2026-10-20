# Telegram Business Lead Qualifier (MVP)

TypeScript + grammY + PostgreSQL. The customer writes to the **existing company Telegram account**; the connected Business Bot responds only **after** receiving the customer's first incoming message, collects a 5-step brief, requests permission to share data, and sends a qualified lead to one of the managers' **personal Telegram chats**. The manager contacts the customer personally.

## Requirements

- Node.js >= 22, Docker for local PostgreSQL.
- A service bot from [@BotFather](https://t.me/BotFather) (token is confidential).
- Existing company Telegram account with **Telegram Business → Chatbots** (connected bots are supported without Premium as of May 2026).
- Each manager's numeric Telegram ID and public @username (required for fallback contact).

## Run locally

```bash
cp .env.example .env
# Fill BOT_TOKEN and MANAGERS_JSON in .env
docker compose up -d
npm install
npm run dev
```

The server automatically creates database tables and syncs configured managers.

### Telegram setup

1. Use [@BotFather](https://t.me/BotFather) to create a bot. Enable **Secretary Mode / Business Mode** for that bot (the current UI may name it differently).
2. From **each manager's personal account**, open this service bot and send `/start`. If the manager doesn't know their numeric Telegram ID, the bot shows it even before registration; add IDs into `.env` and restart.
3. In the **existing company account**, open `Settings → Telegram Business → Chatbots`, connect the new service bot, allow access to **new customer chats** and enable the permission to **reply to messages**. Exclude internal/company chats. Telegram's wording may vary by app version.
4. On the website, point the button **to the existing company account**: `https://t.me/<company_username>`. Do **not** point the website to the service bot if using Business mode.
5. From a third, unrelated Telegram account, write a test message to the company. The bot should ask the first question; after answers and consent, one manager will get an alert.

## Questionnaire

1. Service
2. Project description (minimum 20 characters)
3. Budget (unknown allowed)
4. Deadline (unknown allowed)
5. Phone or optional skip
6. Explicit consent to forward contact/details to a manager

This MVP validates whether answers are present and plausible; it does **not** use AI or guarantee that a lead is genuine. Messages after the lead is assigned aren't auto-answered. `/new` restarts cancelled or unassigned conversations, not already accepted leads.

## Manager workflow

Each manager receives a message with name, client @username (if any), contact phone (if provided), description, budget and timeline. There are **Take lead** and **Decline** buttons. On decline or failed notification, another manager is tried. An unaccepted lead times out after 30 minutes and is offered to a different manager; never to the same one twice for that application. If nobody is available, the lead becomes `needs_attention` and the optional `ADMIN_TELEGRAM_ID` gets an alert. Manager must send `/start` to the service bot first.

**Contact limitations:** A numeric Telegram ID does not guarantee an unsolicited private chat from a personal account. A public @username supports `https://t.me/username`. A phone number may be hidden by privacy settings. If the client provided neither public @username nor phone, when a manager accepts the lead the client is asked to message that manager first by @username (required in `MANAGERS_JSON`). If the business 24-hour reply window has expired, this notice cannot always be sent; an external CRM/manual follow-up may be required.

## Privacy and production considerations

- The bot asks for consent before sharing data with a specific manager.
- Never commit `.env` or log tokens or the customer's personal contact data.
- Limit the Business bot to required permissions and chat scope.
- Configure a retention policy for personal data in PostgreSQL; this MVP does not include automatic deletion, consent revocation, or a privacy policy for the website.
- PostgreSQL password in docker-compose is **development-only**. Use managed Postgres and TLS for production.
- Long polling: run **one bot process**. For HA/multiple replicas, migrate to webhook + distributed processing/locking.
- If bot delivery fails repeatedly or the chat is unreachable, use `ADMIN_TELEGRAM_ID` for operational alerts. The admin must also send `/start` to this bot.
- Accept/decline callback operations are authorized by exact Telegram ID and checked atomically in the database.
- A very old business chat (>24 hours without an incoming customer message) cannot reliably receive a new automated business reply.
- If production robustness is required, replace the simple polling dispatcher with an outbox/queue, and implement detailed admin tooling and retention workflows.

## Source

- `src/index.ts` — grammY handlers, Telegram Business events
- `src/qualification.ts` — questionnaire + validation
- `src/dispatch.ts` — manager assignment/notifications
- `src/db.ts` — PostgreSQL queries and state
- `sql/schema.sql` — schema
- `.env.example` — configuration template
# tentmax-bot
