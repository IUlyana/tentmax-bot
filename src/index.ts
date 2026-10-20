import { Bot } from 'grammy';
import { config } from './config.js';
import { acceptLead, claimMessage, createLead, declineLead, findLead, getManager, initDb, pool, queueLead, resetLead, updateLead } from './db.js';
import { alertAdmin, dispatchOne, dispatchQueued, informClientOnAcceptance, recentCounts } from './dispatch.js';
import { evaluate, START_QUESTION } from './qualification.js';

const bot = new Bot(config.token);

bot.catch((err) => {
  console.error('Telegram update error:', err.error instanceof Error ? err.error.message : String(err.error));
});

bot.on('business_connection', async (ctx) => {
  const connection = ctx.businessConnection;
  console.info(`Business connection ${connection.id}: active=${connection.is_enabled}, replies=${connection.rights?.can_reply ?? false}`);
  if (connection.is_enabled && !connection.rights?.can_reply) {
    await alertAdmin(bot, 'Business-боту не выдано право отвечать на сообщения (can_reply).');
  }
});

bot.on('business_message', async (ctx) => {
  const msg = ctx.businessMessage;
  const from = msg.from;
  if (!from || from.is_bot || msg.chat.type !== 'private') return;

  // Business connections also deliver outgoing messages from the account owner.
  // Never answer those, or messages sent by a business bot.
  if (msg.sender_business_bot) return;
  const connection = await ctx.getBusinessConnection();
  if (!connection.is_enabled || !connection.rights?.can_reply || from.id === connection.user.id) return;

  const chatId = msg.chat.id;
  const connectionId = msg.business_connection_id;
  if (!connectionId) return;
  const text = (msg.text ?? msg.caption ?? '').trim().slice(0, 2000);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  const reply = async (replyText: string) => bot.api.sendMessage(chatId, replyText, { business_connection_id: connectionId });

  const existing = await findLead(connectionId, chatId);
  if (!existing) {
    // Must start only after customer's first inbound message.
    await createLead({ connectionId, chatId, userId: from.id, name, username: from.username, firstMessage: text || '[вложение]', messageId: msg.message_id });
    await reply(START_QUESTION);
    return;
  }

  const lead = await claimMessage(existing.id, msg.message_id, from.username, name);
  if (!lead) return; // repeated Telegram update

  if (text.toLowerCase() === '/new' && (lead.status === 'cancelled' || lead.status === 'needs_attention')) {
    await resetLead(lead.id, msg.message_id, text);
    await reply(START_QUESTION);
    return;
  }
  if (lead.status !== 'collecting') return;

  if (!text && !msg.contact) {
    await reply('Пожалуйста, ответьте текстом. Файлы и голосовые сообщения можно будет обсудить с менеджером после передачи заявки.');
    return;
  }

  if (lead.step === 'consent' && ['нет', 'не согласен', 'не согласна'].includes(text.toLowerCase())) {
    await updateLead(lead.id, { status: 'cancelled', step: 'done' });
    await reply('Хорошо, не будем передавать ваши данные менеджерам. Если передумаете, напишите /new.');
    return;
  }

  const contactPhone = msg.contact && (!msg.contact.user_id || msg.contact.user_id === from.id)
    ? msg.contact.phone_number
    : undefined;
  const answer = evaluate(lead.step, text, lead, contactPhone);
  if (!answer.ok) {
    await reply(answer.reply);
    return;
  }

  await updateLead(lead.id, { ...answer.update, step: answer.next });
  if (answer.next === 'done') {
    await queueLead(lead.id);
    await reply(answer.reply);
    await dispatchOne(bot, lead.id);
    return;
  }
  await reply(answer.reply);
});

bot.on('message', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const manager = await getManager(ctx.from.id);
  if (ctx.message.text?.startsWith('/start')) {
    await ctx.reply(manager
      ? `Здравствуйте, ${manager.name}! Ваш Telegram ID: ${ctx.from.id}. Вы добавлены в список менеджеров. Бот будет присылать вам новые заявки.\n\nКоманда /status покажет статистику.`
      : `Ваш Telegram ID: ${ctx.from.id}. Передайте этот ID администратору, чтобы он добавил вас в список менеджеров.`);
  } else if (ctx.message.text?.startsWith('/status') && manager) {
    await ctx.reply(`Заявки менеджера ${manager.name}:\n${await recentCounts(ctx.from.id)}`);
  }
});

bot.callbackQuery(/^(accept|decline):(\d+)$/, async (ctx) => {
  const action = ctx.match[1];
  const leadId = ctx.match[2];
  const manager = await getManager(ctx.from.id);
  if (!manager) return void await ctx.answerCallbackQuery({ text: 'Доступ запрещён', show_alert: true });

  if (action === 'accept') {
    const lead = await acceptLead(leadId, manager.telegram_id);
    if (!lead) return void await ctx.answerCallbackQuery({ text: 'Заявка уже обработана или назначена другому менеджеру', show_alert: true });
    await ctx.answerCallbackQuery({ text: 'Заявка ваша' });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await ctx.reply(`✅ Вы взяли заявку #${leadId}. Свяжитесь с клиентом лично по @username или телефону, указанным выше.`);
    await informClientOnAcceptance(bot, lead, manager);
    return;
  }
  const lead = await declineLead(leadId, manager.telegram_id);
  if (!lead) return void await ctx.answerCallbackQuery({ text: 'Заявка уже обработана', show_alert: true });
  await ctx.answerCallbackQuery({ text: 'Передаём следующему менеджеру' });
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  await ctx.reply(`⏭ Отказ от заявки #${leadId} сохранён.`);
  await dispatchOne(bot, leadId);
});

async function main(): Promise<void> {
  await initDb();
  // One process only: bot.start uses long polling. Stop any webhook before switching to polling.
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  await dispatchQueued(bot);
  const timer = setInterval(() => {
    void dispatchQueued(bot).catch((err) => console.error('Dispatch worker error:', err instanceof Error ? err.message : String(err)));
  }, 30_000);
  timer.unref();
  process.once('SIGINT', () => { clearInterval(timer); void bot.stop(); });
  process.once('SIGTERM', () => { clearInterval(timer); void bot.stop(); });
  console.info('Lead qualification bot started');
  await bot.start({ allowed_updates: ['business_connection', 'business_message', 'message', 'callback_query'] });
  await pool.end();
}

main().catch((error: unknown) => {
  console.error('Startup error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
