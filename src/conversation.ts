import { Bot, GrammyError, InlineKeyboard, Keyboard } from 'grammy';
import { recordEntry, findLead, getLead, getManager, pool, resetLead, saveAnswer, type Lead } from './db.js';
import { choices, evaluate, prompt } from './qualification.js';
import { validateAnswer } from './ai.js';
import { handleTestCommand } from './testing.js';
import { entryCode } from './entry-message.js';
import { dispatchOne, recentCounts } from './dispatch.js';

export function callbackData(lead: Lead, action: string): string {
  return `q:${lead.id}:${lead.revision}:${action}`;
}

interface PromptDisplay { afterReply?:boolean; canDeleteBusiness?:boolean }

async function retirePrompt(bot: Bot, lead: Lead, messageId: number, display: PromptDisplay): Promise<void> {
  try {
    if (!lead.business_connection_id) {
      await bot.api.deleteMessage(Number(lead.client_chat_id),messageId);
      return;
    }
    if (display.canDeleteBusiness) {
      await bot.api.deleteBusinessMessages(lead.business_connection_id,[messageId]);
      return;
    }
  } catch { /* Deletion can be denied or the message may have expired. */ }
  // Without deletion rights, remove the old question and its interactive buttons.
  await bot.api.editMessageText(Number(lead.client_chat_id),messageId,'Ответ получен.',{
    business_connection_id:lead.business_connection_id || undefined,reply_markup:{inline_keyboard:[]},
  }).catch(() => {});
}

export async function sendPrompt(bot: Bot, lead: Lead, prefix?: string, display: PromptDisplay = {}): Promise<void> {
  const business = lead.business_connection_id || undefined;
  const options = choices(lead);
  const keyboard = new InlineKeyboard();
  for (const [label, action] of options) keyboard.text(label, callbackData(lead, action)).row();
  let text = [prefix, prompt(lead)].filter(Boolean).join('\n\n');
  if (lead.step === 'phone') text += business
    ? '\nНажмите скрепку → «Контакт» и отправьте свой контакт. Если так неудобно, можно написать номер вручную.'
    : '\nНажмите «Поделиться контактом» ниже. Если так неудобно, можно написать номер вручную.';
  const fallback = !!(lead.text_choices && business);
  if (fallback && options.length) text += '\n\n' + options.map(([label]) => `• ${label}`).join('\n') + '\nНапишите название подходящего варианта.';
  const replyKeyboard = !business && lead.step === 'phone';
  const inlineMarkup = fallback ? undefined : {inline_keyboard: keyboard.inline_keyboard.filter(row => row.length > 0)};
  try {
    // Text/contact replies need a fresh message below the client's answer.
    // Button-only transitions can edit the current message in place.
    if (lead.prompt_message_id && !display.afterReply && !replyKeyboard && !lead.prompt_has_reply_keyboard) {
      try {
        await bot.api.editMessageText(Number(lead.client_chat_id), lead.prompt_message_id, text, {
          business_connection_id: business, reply_markup: inlineMarkup,
        });
        return;
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 400 && /message is not modified/i.test(error.description)) return;
        if (!(error instanceof GrammyError && error.error_code === 400 && /message to edit not found|message can't be edited|message can not be edited|message_id_invalid/i.test(error.description))) throw error;
        // A manually deleted or expired prompt must not prevent continuation.
      }
    }
    const markup = replyKeyboard
      ? new Keyboard().requestContact('Поделиться контактом').resized().oneTime()
      : !business && lead.prompt_has_reply_keyboard ? {remove_keyboard: true as const}
      : inlineMarkup;
    const sent = await bot.api.sendMessage(Number(lead.client_chat_id), text, {business_connection_id: business, reply_markup: markup});
    const stored = await pool.query('UPDATE leads SET prompt_message_id=$2,prompt_has_reply_keyboard=$3 WHERE id=$1 AND revision=$4',
      [lead.id,sent.message_id,replyKeyboard,lead.revision]);
    if (!stored.rowCount) { await retirePrompt(bot,lead,sent.message_id,display); return; }
    if (!business && lead.prompt_has_reply_keyboard && !replyKeyboard) {
      // Removing the contact keyboard and attaching inline choices require
      // separate API calls, but still use the same new question message.
      await bot.api.editMessageReplyMarkup(Number(lead.client_chat_id),sent.message_id,{reply_markup:inlineMarkup});
    }
    if (lead.prompt_message_id) await retirePrompt(bot,lead,lead.prompt_message_id,display);
  } catch (error) {
    // Retry only a confirmed unsupported keyboard, never general auth/network errors.
    if (business && !fallback && error instanceof GrammyError && error.error_code === 400 && /(?:button|keyboard|reply.?markup).*(?:unsupported|not supported|not allowed)|(?:unsupported|not supported|not allowed).*(?:button|keyboard|reply.?markup)/i.test(error.description)) {
      await pool.query('UPDATE leads SET text_choices=TRUE WHERE id=$1',[lead.id]);
      await sendPrompt(bot,{...lead,text_choices:true},prefix,display);
      return;
    }
    throw error;
  }
}

async function receive(bot: Bot, data: { connectionId:string; chatId:number; userId:number; name:string; username?:string; text:string; messageId:number; canDeleteBusiness?:boolean; entryText?:string; contact?: {phone_number:string;user_id?:number} }): Promise<void> {
  if (await handleTestCommand(bot,data)) return;
  const display = {afterReply:true,canDeleteBusiness:data.canDeleteBusiness};
  const lead = await findLead(data.connectionId,data.chatId);
  if (!lead) {
    await recordEntry(data,entryCode(data.entryText ?? ''));
    return;
  }
  if (Number(lead.last_message_id) >= data.messageId) return;
  if (data.text.toLowerCase() === '/new') {
    const restarted = await resetLead(lead,data.messageId);
    if (restarted) await sendPrompt(bot,restarted,undefined,display);
    else if (lead.status === 'collecting') await sendPrompt(bot,lead,'Продолжим с того места, где остановились.',display);
    return;
  }
  if (lead.status !== 'collecting') return;
  if (data.text === '/resume' || data.text === '/request' || data.text === '/start') {
    const current = await saveAnswer(lead,{step:lead.step},data.messageId);
    if (current) await sendPrompt(bot,current,undefined,display);
    return;
  }
  if (data.contact && data.contact.user_id !== data.userId) {
    const current = await saveAnswer(lead,{step:lead.step},data.messageId);
    if (current) await sendPrompt(bot,current,'Пожалуйста, поделитесь своим контактом или введите номер для связи вручную.',display);
    return;
  }
  const action = lead.text_choices ? choices(lead).find(([label]) => label.toLocaleLowerCase() === data.text.toLocaleLowerCase())?.[1] : undefined;
  const result = await validateAnswer(lead,evaluate(lead,data.text,action,data.contact?.phone_number));
  if (!result.ok) {
    const current = await saveAnswer(lead,{step:lead.step},data.messageId);
    if (current) await sendPrompt(bot,current,result.reply,display);
    return;
  }
  const saved = await saveAnswer(lead,result.update,data.messageId);
  if (!saved) return; // A concurrent update already advanced the form.
  await sendPrompt(bot,saved,result.reply,display);
  if (saved.status === 'queued') await dispatchOne(bot,saved.id);
}

export function registerConversation(bot: Bot): void {
  bot.on('business_message',async ctx => {
    const msg = ctx.businessMessage;
    const from = msg.from;
    if (!from || from.is_bot || msg.chat.type !== 'private' || msg.sender_business_bot) return;
    const connection = await ctx.getBusinessConnection();
    if (!connection.is_enabled || !connection.rights?.can_reply || from.id === connection.user.id || !msg.business_connection_id) return;
    await receive(bot,{connectionId:msg.business_connection_id,chatId:msg.chat.id,userId:from.id,name:[from.first_name,from.last_name].filter(Boolean).join(' '),username:from.username,text:(msg.text ?? msg.caption ?? '').trim(),entryText:msg.text,canDeleteBusiness:!!(connection.rights?.can_delete_outgoing_messages || connection.rights?.can_delete_all_messages),messageId:msg.message_id,contact:msg.contact});
  });
  bot.on('message',async ctx => {
    if (ctx.chat.type !== 'private' || ctx.from.is_bot) return;
    const text = (ctx.message.text ?? '').trim();
    if (await handleTestCommand(bot,{connectionId:'',chatId:ctx.chat.id,userId:ctx.from.id,name:ctx.from.first_name,username:ctx.from.username,text,messageId:ctx.message.message_id})) return;
    const manager = await getManager(ctx.from.id);
    if (manager) {
      if (text === '/start') await ctx.reply(`Здравствуйте, ${manager.name}! Ваш Telegram ID: ${ctx.from.id}. Вы будете получать заявки TENTMAX. Статистика: /status.`);
      else if (text === '/status') await ctx.reply(await recentCounts(ctx.from.id));
      return;
    }
    await receive(bot,{connectionId:'',chatId:ctx.chat.id,userId:ctx.from.id,name:ctx.from.first_name,username:ctx.from.username,text,entryText:ctx.message.text,messageId:ctx.message.message_id,contact:ctx.message.contact});
  });
  bot.callbackQuery(/^q:(\d+):(\d+):([a-z_]+)$/,async ctx => {
    const [,id,revision,action] = ctx.match;
    const lead = await getLead(id);
    const msg = ctx.callbackQuery.message;
    if (!lead || !msg || msg.chat.type !== 'private' || lead.client_telegram_id !== String(ctx.from.id) || lead.client_chat_id !== String(msg.chat.id)
      || (('business_connection_id' in msg ? msg.business_connection_id : '') || '') !== lead.business_connection_id) {
      await ctx.answerCallbackQuery({text:'Эта кнопка недоступна.'}); return;
    }
    if (lead.business_connection_id) {
      const connection = await bot.api.getBusinessConnection(lead.business_connection_id);
      if (!connection.is_enabled || !connection.rights?.can_reply || ctx.from.id === connection.user.id) { await ctx.answerCallbackQuery({text:'Не удалось ответить в этом чате.'}); return; }
    }
    if (lead.status !== 'collecting' || lead.revision !== Number(revision)) {
      await ctx.answerCallbackQuery({text:'Этот ответ уже учтён. Используйте последнее сообщение или /resume.'}); return;
    }
    // Only buttons actually offered at this step may act on the form.
    const offered = choices(lead).some(([,key]) => key === action);
    if (!offered) { await ctx.answerCallbackQuery({text:'Используйте кнопки текущего вопроса.'}); return; }
    // Acknowledge the button before awaiting a potentially slow API call.
    await ctx.answerCallbackQuery();
    const result = await validateAnswer(lead,evaluate(lead,'',action));
    if (!result.ok) {
      const current = await saveAnswer(lead,{step:lead.step});
      if (current) await sendPrompt(bot,current,result.reply);
      return;
    }
    const saved = await saveAnswer(lead,result.update);
    if (!saved) return;
    await sendPrompt(bot,saved,result.reply);
    if (saved.status === 'queued') await dispatchOne(bot,saved.id);
  });
}
