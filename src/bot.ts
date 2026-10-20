import { Bot } from 'grammy';
import { config } from './config.js';
import { acceptLead, declineLead, getManager } from './db.js';
import { alertAdmin, dispatchOne, informClientOnAcceptance } from './dispatch.js';
import { registerConversation } from './conversation.js';

export function createBot(): Bot {
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

  registerConversation(bot);

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

  return bot;
}
