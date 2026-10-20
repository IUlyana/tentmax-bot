# TENTMAX — заявки на тентовые ангары

TypeScript + grammY + PostgreSQL. The customer writes to the **existing company Telegram account**; the connected Business Bot responds only after the customer sends the exact entry message below and sends nothing else for 3 minutes, collects the TENTMAX project details, requests permission to share data, and sends a qualified lead to one of the managers' **personal Telegram chats**. The manager contacts the customer personally.

## Requirements

- Node.js >= 22, Docker for local PostgreSQL.
- A service bot from [@BotFather](https://t.me/BotFather) (token is confidential).
- Existing company Telegram account with **Telegram Business → Chatbots** (connected bots are supported without Premium as of May 2026).
- Each manager's numeric Telegram ID and public @username (required for fallback contact).

## Run locally

```bash
cp .env.example .env
# Fill BOT_TOKEN and MANAGERS_JSON in .env
# Compose exposes PostgreSQL on 5433 (the template currently uses 5432):
# DATABASE_URL=postgresql://leads:leads_local_password@127.0.0.1:5433/leads
docker compose up -d --wait
npm ci
npm run dev
```

The server automatically creates database tables and syncs configured managers.

### Telegram setup

1. Use [@BotFather](https://t.me/BotFather) to create a bot. Enable **Secretary Mode / Business Mode** for that bot (the current UI may name it differently).
2. From **each manager's personal account**, open this service bot and send `/start`. Add the manager's numeric Telegram ID to `MANAGERS_JSON` and restart first; `/start` then confirms their registration. Unknown users do not receive automatic replies to `/start`.
3. In the **existing company account**, open `Settings → Telegram Business → Chatbots`, connect the new service bot, allow access to **new customer chats** and enable the permission to **reply to messages**. Exclude internal/company chats. Telegram's wording may vary by app version.
4. On the website, point the button **to the existing company account**: `https://t.me/<company_username>`. Do **not** point the website to the service bot if using Business mode.
5. From a third, unrelated Telegram account, send the exact entry message below to the company and wait 3 minutes without further messages. The bot should then ask the first question; after answers and consent, one manager will get an alert.

## Сценарий TENTMAX

В чате обновляется одно сообщение с текущим вопросом — предыдущие вопросы заменяются, а ответы клиента сохраняются. Для запроса контакта в личном чате создаётся новое сообщение, предыдущее удаляется. Идентификатор вопроса хранится в PostgreSQL и восстанавливается после перезапуска.

Вопросы задаются по одному: назначение сооружения → город/регион → ширина → длина → высота прямой стены → тип утепления → имя → телефон → проверка данных и согласие на передачу менеджеру.

- Назначение: склад, производство, спортивный объект, сельское хозяйство, другое.
- Тип: тёплый (2 слоя тента), холодный, утеплённый (2 слоя тента + утеплитель), нужна консультация.
- Выбор и отправка заявки — через inline-кнопки. Размеры вводятся отдельно в метрах, допускаются точка и запятая. Обычные сообщения Telegram не поддерживают несколько полей ввода; Web App для этого не требуется.
- В личном чате с ботом телефон можно отправить стандартной кнопкой `request_contact` либо ввести вручную. Telegram Business не поддерживает reply-клавиатуры и запрос контакта: номер вводится вручную. Чужой контакт не принимается; нужный номер можно ввести текстом.
- Для Business используется `business_connection_id` при отправке и удалении inline-клавиатур. Если API явно отклоняет клавиатуру как неподдерживаемую, режим текстовых ответов сохраняется для этой анкеты: клиент пишет название варианта, без цифр. Прочие ошибки не маскируются этим fallback.
- «Исправить ответы» появляется только на итоговой проверке и позволяет изменить отдельное поле и вернуться к прерванному вопросу или итоговой проверке. `/resume` повторно показывает текущий вопрос. Для исправления во время заполнения также доступна команда `/edit`. Прогресс сохраняется в PostgreSQL после каждого ответа; тайм-аут анкеты не установлен.
- Передача менеджеру происходит только после «Отправить заявку» и проверки обязательных полей. «Не отправлять» отменяет передачу. `/new` начинает заново отменённую или оставшуюся без менеджера заявку; принятые заявки повторно не открываются.
- Новая анкета в Business и в личном чате с ботом начинается только после отдельного текстового сообщения `Обязательно отправьте это сообщение и дождитесь ответа. Ваш номер: rv-267087` (цифры после `rv-` индивидуальны). Лишний текст или подпись к фото не подходят. Бот молчит 3 минуты; любое следующее входящее сообщение клиента, включая фото, контакт или команду, отменяет автозапуск. Повторная отправка специального сообщения начинает новое ожидание. Повторная доставка одного Telegram update таймер не продлевает. Проверка готовности выполняется каждые 5 секунд.
- Ожидание хранится в `conversation_entries` в PostgreSQL. После перезапуска бот сначала 3 минуты принимает накопленные обновления, затем возобновляет отложенные запуски. Просроченные более чем на 23 часа запуски отменяются. При временной ошибке первой отправки предусмотрена повторная попытка. Номер обращения сохраняется в заявке и уведомлении менеджеру.
- `/request`, `/start` и обычное приветствие не начинают новую клиентскую анкету. Для уже начатой анкеты сохраняются возобновление и исправление ответов. Служебные `/start` и `/status` у зарегистрированных менеджеров работают отдельно. Сообщения владельца компании и других ботов игнорируются.

Версия анкеты меняется атомарно при ответах и редактировании. Callback проверяет клиента, чат, Business connection и версию; старые кнопки и параллельные нажатия не меняют данные повторно. Все данные для восстановления хранятся в БД.

## Миграция и проверки

`initDb()` автоматически применяет идемпотентное расширение `sql/schema.sql`: новые поля и версия анкеты добавляются без удаления старых данных. Незавершённые анкеты прежнего сценария начинают новый сценарий с назначения; старые ответы сохраняются в прежних столбцах. Назначенные и принятые заявки сохраняют статус и менеджера. Анкеты, остановленные на прежнем вопросе о сроках, продолжаются с имени; ранее сохранённые сроки остаются в БД, но в новой анкете и уведомлении не показываются. Перед обновлением рабочей БД сделайте резервную копию.

```bash
npm run check
npm test
# Интеграционный тест: отдельная временная схема в указанной PostgreSQL БД.
# Требуются права CREATE SCHEMA; схема удаляется после теста.
TEST_DATABASE_URL=postgresql://leads:leads_local_password@127.0.0.1:5433/leads npm test
```

Без `TEST_DATABASE_URL` интеграционный тест явно пропускается. С ним проверяются реальная PostgreSQL, миграция старой схемы, последовательность обработчиков, возобновление после перезапуска, редактирование, дубли, устаревшие и чужие кнопки, оба способа ввода телефона, Business fallback, содержимое уведомления и принятие менеджером. Telegram API подменён: тест не отправляет сообщения людям и не требует токена. Для проверки в Telegram отдельно нужны действующий токен, Business-подключение и тестовые аккаунты клиента/менеджера.

## Manager workflow

Each manager receives a message with purpose, city/region, width, length, straight-wall height, insulation type, contact name, required phone, client Telegram username (if any), Telegram ID and consent status. There are **Take lead** and **Decline** buttons. On decline or failed notification, another manager is tried. An unaccepted lead times out after 30 minutes and is offered to a different manager; never to the same one twice for that application. If nobody is available, the lead becomes `needs_attention` and the optional `ADMIN_TELEGRAM_ID` gets an alert. Manager must send `/start` to the service bot first.

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

- `src/index.ts` — database initialization and polling startup
- `src/bot.ts` — bot factory, Business connection and manager handlers
- `src/conversation.ts` — client messages, callback validation, keyboards and Business fallback
- `src/entry.ts` — persisted delayed starts after the entry message and silence
- `src/entry-message.ts` — exact entry-message validation
- `src/qualification.ts` — questionnaire + validation
- `src/dispatch.ts` — manager assignment/notifications
- `src/db.ts` — PostgreSQL queries and state
- `sql/schema.sql` — schema
- `.env.example` — configuration template
# tentmax-bot
