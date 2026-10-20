import type { Bot } from 'grammy';
import { config } from './config.js';
import { clearTestConversation, recordEntry, type EntryInput } from './db.js';

export async function handleTestCommand(bot: Bot, data: EntryInput): Promise<boolean> {
  if (data.text !== '/test_id' && data.text !== '/test_reset') return false;
  const business = data.connectionId || undefined;
  const reply = (text:string) => bot.api.sendMessage(data.chatId,text,{business_connection_id:business});
  if (data.text === '/test_id') {
    await recordEntry(data,null);
    await reply(`Ваш Telegram ID: ${data.userId}. Для сброса тестовой анкеты этот ID должен быть указан в TESTER_TELEGRAM_IDS на сервере.`);
    return true;
  }
  if (!config.testerIds.has(data.userId) && data.userId !== config.adminId) {
    await recordEntry(data,null);
    await reply(`Сброс доступен только тестовым аккаунтам. Ваш Telegram ID: ${data.userId}. Добавьте его в TESTER_TELEGRAM_IDS в настройках сервера.`);
    return true;
  }
  const result = await clearTestConversation(data);
  if (!result.handled) return true;
  const text = 'Тестовая анкета в этом чате сброшена. Отправьте специальное сообщение с номером rv-… и подождите 3 минуты, ничего больше не отправляя, чтобы начать заново.';
  const promptId = result.lead?.prompt_message_id;
  if (business && promptId) {
    try {
      await bot.api.editMessageText(data.chatId,promptId,text,{business_connection_id:business,reply_markup:{inline_keyboard:[]}});
      return true;
    } catch { /* A missing or expired message must not prevent a reset. */ }
  }
  await bot.api.sendMessage(data.chatId,text,{business_connection_id:business,...(!business ? {reply_markup:{remove_keyboard:true}} : {})});
  if (promptId) {
    if (!business) await bot.api.deleteMessage(data.chatId,promptId).catch(() => {});
    else await bot.api.editMessageReplyMarkup(data.chatId,promptId,{business_connection_id:business,reply_markup:{inline_keyboard:[]}}).catch(() => {});
  }
  return true;
}
