import { Bot } from 'grammy';
import { config } from './config.js';
import { alertAdmin } from './dispatch.js';
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

  return bot;
}
