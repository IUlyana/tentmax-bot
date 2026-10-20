import { Bot, GrammyError, InlineKeyboard, Keyboard } from 'grammy';
import { createLead, findLead, getLead, getManager, pool, resetLead, saveAnswer, type Lead } from './db.js';
import { choices, evaluate, prompt } from './qualification.js';
import { dispatchOne, recentCounts } from './dispatch.js';

export function callbackData(lead: Lead, action: string): string {
  return `q:${lead.id}:${lead.revision}:${action}`;
}

export async function sendPrompt(bot: Bot, lead: Lead, prefix?: string): Promise<void> {
  const business = lead.business_connection_id || undefined;
  const options = choices(lead);
  const keyboard = new InlineKeyboard();
  for (const [label, action] of options) keyboard.text(label, callbackData(lead, action)).row();
  if (lead.status === 'collecting' && lead.step !== 'edit' && lead.step !== 'review') keyboard.text('Изменить данные', callbackData(lead, 'edit'));
  let text = [prefix, prompt(lead)].filter(Boolean).join('\n\n');
  if (lead.step === 'phone') text += business ? '\nВ этом чате номер нужно ввести вручную. Изменить ответы: /edit.' : '\nМожно поделиться контактом кнопкой ниже или ввести номер вручную. Изменить ответы: /edit.';
  const fallback = lead.text_choices && business;
  if (fallback && options.length) text += '\n\n' + options.map(([label]) => `• ${label}`).join('\n') + '\nНапишите название подходящего варианта.';
  if (fallback && lead.status === 'collecting') text += '\nИзменить ответы: /edit. Продолжить позже: /resume.';
  const markup = !business && lead.step === 'phone'
    ? new Keyboard().requestContact('Поделиться номером телефона').resized().oneTime()
    : fallback ? undefined : keyboard.inline_keyboard.length ? keyboard : (!business ? { remove_keyboard: true as const } : undefined);
  try {
    await bot.api.sendMessage(Number(lead.client_chat_id), text, {business_connection_id:business,reply_markup:markup});
  } catch (error) {
    // Retry only a confirmed unsupported keyboard, never general auth/network errors.
    if (business && !fallback && error instanceof GrammyError && error.error_code === 400 && /(?:button|keyboard|reply.?markup).*(?:unsupported|not supported|not allowed)|(?:unsupported|not supported|not allowed).*(?:button|keyboard|reply.?markup)/i.test(error.description)) {
      await pool.query('UPDATE leads SET text_choices=TRUE WHERE id=$1',[lead.id]);
      await sendPrompt(bot,{...lead,text_choices:true},prefix);
      return;
    }
    throw error;
  }
}

async function receive(bot: Bot, data: { connectionId:string; chatId:number; userId:number; name:string; username?:string; text:string; messageId:number; contact?: {phone_number:string;user_id?:number} }): Promise<void> {
  const lead = await findLead(data.connectionId,data.chatId);
  if (!lead) {
    const result = await createLead({...data,firstMessage:data.text || '[вложение]'});
    // Concurrent first messages must not both start questionnaires.
    if (result.created) await sendPrompt(bot,result.lead);
    return;
  }
  if (Number(lead.last_message_id) >= data.messageId) return;
  if (data.text.toLowerCase() === '/new') {
    const restarted = await resetLead(lead,data.messageId);
    if (restarted) await sendPrompt(bot,restarted);
    else if (lead.status === 'collecting') await sendPrompt(bot,lead,'Продолжим с того места, где остановились.');
    return;
  }
  if (lead.status !== 'collecting') return;
  if (data.text === '/resume' || data.text === '/request' || data.text === '/start') {
    const current = await saveAnswer(lead,{step:lead.step},data.messageId);
    if (current) await sendPrompt(bot,current);
    return;
  }
  if (data.contact && data.contact.user_id !== data.userId) {
    const current = await saveAnswer(lead,{step:lead.step},data.messageId);
    if (current) await sendPrompt(bot,current,'Пожалуйста, поделитесь своим контактом или введите номер для связи вручную.');
    return;
  }
  const action = lead.text_choices ? choices(lead).find(([label]) => label.toLocaleLowerCase() === data.text.toLocaleLowerCase())?.[1] : undefined;
  const result = evaluate(lead,data.text,action,data.contact?.phone_number);
  if (!result.ok) {
    const current = await saveAnswer(lead,{step:lead.step},data.messageId);
    if (current) await sendPrompt(bot,current,result.reply);
    return;
  }
  const saved = await saveAnswer(lead,result.update,data.messageId);
  if (!saved) return; // A concurrent update already advanced the form.
  await sendPrompt(bot,saved);
  if (saved.status === 'queued') await dispatchOne(bot,saved.id);
}

export function registerConversation(bot: Bot): void {
  bot.on('business_message',async ctx => {
    const msg = ctx.businessMessage;
    const from = msg.from;
    if (!from || from.is_bot || msg.chat.type !== 'private' || msg.sender_business_bot) return;
    const connection = await ctx.getBusinessConnection();
    if (!connection.is_enabled || !connection.rights?.can_reply || from.id === connection.user.id || !msg.business_connection_id) return;
    await receive(bot,{connectionId:msg.business_connection_id,chatId:msg.chat.id,userId:from.id,name:[from.first_name,from.last_name].filter(Boolean).join(' '),username:from.username,text:(msg.text ?? msg.caption ?? '').trim(),messageId:msg.message_id,contact:msg.contact});
  });
  bot.on('message',async ctx => {
    if (ctx.chat.type !== 'private' || ctx.from.is_bot) return;
    const text = (ctx.message.text ?? '').trim();
    const manager = await getManager(ctx.from.id);
    if (manager) {
      if (text === '/start') await ctx.reply(`Здравствуйте, ${manager.name}! Ваш Telegram ID: ${ctx.from.id}. Вы будете получать заявки TENTMAX. Статистика: /status.`);
      else if (text === '/status') await ctx.reply(await recentCounts(ctx.from.id));
      return;
    }
    if (text === '/start' && !await findLead('',ctx.chat.id)) {
      await ctx.reply(`Здравствуйте! Это TENTMAX. Чтобы обсудить ангар, напишите /request.\nЕсли вы менеджер, передайте администратору ваш Telegram ID: ${ctx.from.id}.`);
      return;
    }
    await receive(bot,{connectionId:'',chatId:ctx.chat.id,userId:ctx.from.id,name:ctx.from.first_name,username:ctx.from.username,text,messageId:ctx.message.message_id,contact:ctx.message.contact});
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
    const offered = choices(lead).some(([,key]) => key === action) || (action === 'edit' && lead.step !== 'edit');
    if (!offered) { await ctx.answerCallbackQuery({text:'Используйте кнопки текущего вопроса.'}); return; }
    const result = evaluate(lead,'',action);
    if (!result.ok) { await ctx.answerCallbackQuery({text:result.reply}); return; }
    const saved = await saveAnswer(lead,result.update);
    await ctx.answerCallbackQuery({text:saved ? undefined : 'Этот ответ уже учтён.'});
    if (!saved) return;
    await bot.api.editMessageReplyMarkup(msg.chat.id,msg.message_id,{business_connection_id:lead.business_connection_id || undefined,reply_markup:{inline_keyboard:[]}}).catch(() => {});
    await sendPrompt(bot,saved);
    if (saved.status === 'queued') await dispatchOne(bot,saved.id);
  });
}
