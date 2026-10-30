import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';

// An isolated schema and fake Telegram transport: never contacts Telegram or users.
test('PostgreSQL + Telegram handlers: migration, resume, edits, stale buttons, delivery and manager actions', {skip:!process.env.TEST_DATABASE_URL}, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  const admin = new pg.Client({connectionString:url.toString()});
  await admin.connect();
  const schema = `tentmax_test_${process.pid}_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options',`-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.TESTER_TELEGRAM_IDS = '42';
  process.env.AI_API_KEY = 'offline-ai-fixture';
  let aiMode: 'accept' | 'clarify' | 'unavailable' = 'accept';
  let aiField = 'city';
  const aiRequests: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url,options) => {
    assert.equal(String(url),'https://api.openai.com/v1/chat/completions');
    aiRequests.push(JSON.parse(options!.body as string));
    if (aiMode === 'unavailable') return new Response('{}',{status:503});
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({decision:aiMode,field:aiMode==='accept'?null:aiField})}}]});
  };
  process.env.BOT_TOKEN = '123456789:offline_test_token';
  process.env.MANAGERS_JSON = JSON.stringify([{id:9001,name:'Менеджер',username:'manager_test'},{id:9002,name:'Второй',username:'manager_second'}]);
  process.env.ADMIN_TELEGRAM_ID = '7000';
  const db = await import('../src/db.js');
  const {createBot} = await import('../src/bot.js');
  const {readFileSync} = await import('node:fs');
  const {callbackData} = await import('../src/conversation.js');
  const {startDueConversations} = await import('../src/entry.js');
  const trigger = 'Обязательно отправьте это сообщение и дождитесь ответа. Ваш номер: rv-267087';
  async function expireEntry(business=true) {
    await db.pool.query(`UPDATE conversation_entries SET start_after=now()-interval '1 second' WHERE business_connection_id=$1 AND chat_id=42 AND start_after IS NOT NULL`,[business?'business-test':'']);
  }
  const calls: {method:string;payload:any}[] = [];
  let outgoingId = 1000;
  let updateId = 0;
  let failKeyboard = false;
  let failManager = false;
  let missingPrompt = false;
  let failFirstGreeting = false;
  let canDeleteBusiness = true;
  let denyDeletion = false;
  const visible = new Map<number,any>();
  function makeBot() {
    const bot = createBot();
    bot.botInfo = {id:123456789,is_bot:true,first_name:'TENTMAX',username:'tentmax_test_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false,can_connect_to_business:true,has_main_web_app:false};
    bot.api.config.use(async (_prev,method,payload:any) => {
      calls.push({method,payload});
      if (method === 'getBusinessConnection') return {ok:true,result:{id:'business-test',user:{id:1,is_bot:false,first_name:'Company'},user_chat_id:1,date:1,is_enabled:true,rights:{can_reply:true,...(canDeleteBusiness ? {can_delete_outgoing_messages:true} : {})}}} as any;
      if (method === 'sendMessage') {
        if (failFirstGreeting && payload.chat_id===42) { failFirstGreeting=false; return {ok:false,error_code:503,description:'Temporary Telegram outage'} as any; }
        if (failKeyboard && payload.business_connection_id && payload.reply_markup) return {ok:false,error_code:400,description:'Bad Request: reply markup not supported for business messages'} as any;
        if (failManager && payload.chat_id === 9001) return {ok:false,error_code:403,description:'Forbidden: bot was blocked by the user'} as any;
        const result = {message_id:++outgoingId,date:1,chat:{id:payload.chat_id,type:'private'},text:payload.text,business_connection_id:payload.business_connection_id};
        visible.set(result.message_id,{...payload});
        return {ok:true,result} as any;
      }
      if (method === 'editMessageText') {
        if (missingPrompt) { missingPrompt=false; visible.delete(payload.message_id); return {ok:false,error_code:400,description:'Bad Request: message to edit not found'} as any; }
        if (failKeyboard && payload.business_connection_id && payload.reply_markup?.inline_keyboard?.length) return {ok:false,error_code:400,description:'Bad Request: reply markup not supported for business messages'} as any;
        visible.set(payload.message_id,{...payload});
      }
      if (method === 'deleteMessage') visible.delete(payload.message_id);
      if (method === 'deleteBusinessMessages') {
        if (denyDeletion) return {ok:false,error_code:403,description:'Forbidden: deletion denied'} as any;
        for (const id of payload.message_ids) visible.delete(id);
      }
      if (method === 'editMessageReplyMarkup' && visible.has(payload.message_id)) visible.get(payload.message_id).reply_markup=payload.reply_markup;
      return {ok:true,result:true} as any;
    });
    // Surface errors to the test instead of the production logging handler.
    bot.catch(err => {throw err.error;});
    return bot;
  }
  let bot = makeBot();
  const from = {id:42,is_bot:false,first_name:'Клиент',username:'client_test'};
  let messageId = 0;
  async function message(text?:string, contact?:any, business=true, explicitId?:number) {
    const msg = {message_id:explicitId ?? ++messageId,date:1,chat:{id:42,type:'private'},from,text,contact,...(business ? {business_connection_id:'business-test'} : {})};
    await bot.handleUpdate({update_id:++updateId,[business?'business_message':'message']:msg} as any);
  }
  async function lead() { const result = await db.findLead('business-test',42); assert.ok(result); return result; }
  async function click(action:string, snapshot?:Awaited<ReturnType<typeof lead>>, actor=42) {
    const current = snapshot ?? await lead();
    await bot.handleUpdate({update_id:++updateId,callback_query:{id:String(updateId),from:{...from,id:actor},chat_instance:'test',data:callbackData(current,action),message:{message_id:current.prompt_message_id ?? outgoingId,date:1,chat:{id:42,type:'private'},...(current.business_connection_id ? {business_connection_id:current.business_connection_id} : {})}}} as any);
  }
  try {
    // Simulate an existing installation and verify the additive migration twice.
    const oldSchema = readFileSync('sql/schema.sql','utf8').split('-- Additive migration:')[0];
    await db.pool.query(oldSchema);
    await db.pool.query(`INSERT INTO leads(business_connection_id,client_chat_id,client_telegram_id,step,status,service) VALUES ('legacy',1,1,'description','collecting','Old service'),('legacy',2,2,'done','accepted','Archived service')`);
    await db.initDb();
    // Simulate existing TENTMAX forms paused at the removed question or editing
    // another field before returning to it. Migration must preserve their answers.
    await db.pool.query('ALTER TABLE leads DROP CONSTRAINT valid_lead_step');
    await db.pool.query(`INSERT INTO leads(business_connection_id,client_chat_id,client_telegram_id,step,resume_step,purpose,city,revision)
      VALUES ('retired-step',1,1,'deadline',NULL,'Склад','Тула',7),
             ('retired-step',2,2,'edit','deadline','Склад','Омск',8)`);
    await db.initDb();
    const migrated = await db.findLead('retired-step',1);
    assert.equal(migrated?.step,'contact_name');
    assert.equal(migrated?.city,'Тула');
    assert.equal(migrated?.revision,8);
    assert.equal((await db.findLead('retired-step',2))?.resume_step,'contact_name');
    await db.initDb();
    assert.equal((await db.findLead('retired-step',1))?.revision,8);
    assert.equal((await db.findLead('legacy',1))?.step,'purpose');
    assert.equal((await db.findLead('legacy',2))?.status,'accepted');
    assert.equal((await db.findLead('legacy',2))?.service,'Archived service');
    await message('Здравствуйте');
    assert.equal(await db.findLead('business-test',42),null);
    assert.equal(calls.some(c => c.method==='sendMessage'),false);
    await bot.handleUpdate({update_id:++updateId,business_message:{message_id:++messageId,date:1,chat:{id:42,type:'private'},from,business_connection_id:'business-test',photo:[{file_id:'test',file_unique_id:'test',width:1,height:1}],caption:trigger}} as any);
    await expireEntry(); await startDueConversations(bot);
    assert.equal(await db.findLead('business-test',42),null);
    await message(trigger);
    await startDueConversations(bot);
    assert.equal(await db.findLead('business-test',42),null);
    const delay = await db.pool.query(`SELECT extract(epoch FROM start_after-now())::float AS seconds FROM conversation_entries WHERE chat_id=42`);
    assert.ok(delay.rows[0].seconds > 170 && delay.rows[0].seconds <= 180);
    // A further client message while waiting restarts the three-minute countdown
    // (keeping the original rv-code) instead of cancelling it, so no form starts yet.
    await message('Дополнение');
    const restarted = await db.pool.query(`SELECT extract(epoch FROM start_after-now())::float AS seconds, request_code FROM conversation_entries WHERE chat_id=42`);
    assert.ok(restarted.rows[0].seconds > 170 && restarted.rows[0].seconds <= 180);
    assert.equal(restarted.rows[0].request_code,'rv-267087');
    await startDueConversations(bot);
    assert.equal(await db.findLead('business-test',42),null);
    // A redelivered update (message_id not greater) must not restart the timer.
    await expireEntry();
    await message('Дополнение',undefined,true,messageId);
    const replay = await db.pool.query(`SELECT extract(epoch FROM start_after-now())::float AS seconds FROM conversation_entries WHERE chat_id=42`);
    assert.ok(replay.rows[0].seconds <= 0);
    assert.equal(await db.findLead('business-test',42),null);
    await message(trigger);
    await expireEntry();
    const obsolete = (await db.dueEntries())[0];
    await message('Ещё одно сообщение');
    assert.equal(await db.activateEntry(obsolete),null);
    await message(trigger);
    await expireEntry();
    const interrupted = await db.activateEntry((await db.dueEntries())[0]);
    assert.ok(interrupted);
    assert.equal(interrupted.prompt_message_id,null);
    bot = makeBot(); // Resume both the persisted delay and an interrupted start.
    await startDueConversations(bot);
    assert.equal(calls.some(c => c.method==='sendMessage'),false);
    await expireEntry();
    await Promise.all([startDueConversations(bot),startDueConversations(bot)]);
    const first = await lead();
    assert.equal(first.step,'purpose');
    assert.equal(first.request_code,'rv-267087');
    assert.ok(calls.find(c => c.method==='sendMessage' && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.text==='Склад'));
    await click('warehouse',first,43); assert.equal((await lead()).revision,first.revision);
    await Promise.all([click('warehouse',first),click('production',first)]);
    assert.equal((await lead()).revision,first.revision+1);
    await click('sport',first); assert.equal((await lead()).step,'city');
    const aiCallsBeforeNoise = aiRequests.length;
    // On the city step. A repeated-letter answer is rejected locally, before AI,
    // and counts as the first irrelevant attempt.
    aiMode = 'accept';
    await message('ggg');
    assert.equal((await lead()).step,'city');
    assert.equal((await lead()).city,null);
    assert.equal((await lead()).attempts,1);
    assert.ok(visible.get((await lead()).prompt_message_id!).text.includes('Уточните город'));
    assert.equal(aiRequests.length,aiCallsBeforeNoise); // never reached the model
    // An unavailable AI check is not the client's fault: reprompt without
    // consuming an attempt.
    aiMode = 'unavailable';
    await message('Казань');
    const retryPrompt = await lead();
    assert.equal(retryPrompt.step,'city');
    assert.equal(retryPrompt.attempts,1); // unchanged by the AI failure
    assert.ok(visible.get(retryPrompt.prompt_message_id!).text.includes('Сейчас не получается проверить ответ'));
    // A second consecutive genuine irrelevant answer stops the dialog silently.
    aiMode = 'clarify'; aiField = 'city';
    const beforeStop = await lead();
    await message('фигня какая-то');
    const stoppedLead = await lead();
    assert.equal(stoppedLead.stopped,true);
    assert.equal(stoppedLead.attempts,2);
    assert.equal(stoppedLead.step,'city');
    assert.equal(stoppedLead.city,null);
    assert.equal(stoppedLead.prompt_message_id,beforeStop.prompt_message_id); // no new message sent
    // A random message does not resume a stopped dialog.
    aiMode = 'accept';
    await message('Москва');
    assert.equal((await lead()).stopped,true);
    assert.equal((await lead()).city,null);
    // Explicit /resume continues from the saved question and clears the counter.
    await message('/resume');
    const resumed = await lead();
    assert.equal(resumed.stopped,false);
    assert.equal(resumed.attempts,0);
    assert.equal(resumed.step,'city');
    // A correct answer now advances and keeps the counter at zero.
    await message('Москва');
    const widthPrompt = await lead();
    assert.equal(widthPrompt.city,'Москва');
    assert.equal(widthPrompt.step,'width');
    assert.equal(widthPrompt.attempts,0);
    assert.notEqual(widthPrompt.prompt_message_id,first.prompt_message_id);
    assert.equal(visible.has(first.prompt_message_id!),false);
    assert.equal(visible.get(widthPrompt.prompt_message_id!).text.includes('ширина'),true);
    assert.equal(visible.get(widthPrompt.prompt_message_id!).text.includes('проверить ответ'),false);
    assert.equal(visible.get(widthPrompt.prompt_message_id!).reply_markup.inline_keyboard.length,0);
    assert.ok(calls.some(c => c.method==='deleteBusinessMessages' && c.payload.business_connection_id==='business-test'));
    // Without deletion rights the old question collapses to a short notice while
    // the new question still follows the client's reply as a fresh message.
    canDeleteBusiness = false;
    await message('18,5');
    assert.equal((await lead()).step,'length');
    assert.equal((await lead()).width,'18.5');
    assert.equal(visible.get(widthPrompt.prompt_message_id!).text,'Ответ получен.');
    assert.notEqual((await lead()).prompt_message_id,widthPrompt.prompt_message_id);
    canDeleteBusiness = true;
    // Simulate process restart: nothing in memory is required to resume.
    bot = makeBot(); await message('/resume'); assert.equal((await lead()).step,'length');
    assert.notEqual((await lead()).prompt_message_id,first.prompt_message_id);
    // Deletion denied by the account also collapses the old question in place.
    denyDeletion = true;
    const protectedPrompt = await lead();
    await message('40');
    assert.equal((await lead()).step,'wall_height');
    assert.equal(visible.get(protectedPrompt.prompt_message_id!).text,'Ответ получен.');
    denyDeletion = false;
    await message('6,2');
    await click('insulated');
    assert.equal((await lead()).step,'contact_name');
    await message('Александр');
    const phoneLead = await lead(); assert.equal(phoneLead.step,'phone');
    const phonePrompt = calls.filter(c => ['sendMessage','editMessageText'].includes(c.method) && c.payload.text.includes('Поделитесь, пожалуйста, своим контактом')).at(-1)!;
    assert.equal(phonePrompt.payload.reply_markup?.keyboard,undefined);
    assert.match(phonePrompt.payload.text,/скрепку → «Контакт»/);
    await message(undefined,{phone_number:'79991234567',first_name:'Чужой',user_id:43}); assert.equal((await lead()).step,'phone');
    await message(undefined,{phone_number:'79991234567',first_name:'Клиент',user_id:42});
    assert.equal((await lead()).step,'review');
    assert.equal((await lead()).phone,'+79991234567');
    // Manual entry remains available when sharing a contact is inconvenient.
    await message('/edit'); await click('field_phone');
    await message('+7 (999) 123-45-67'); assert.equal((await lead()).step,'review');
    assert.ok(calls.some(c => c.method==='editMessageText' && c.payload.business_connection_id==='business-test'));
    const reviewPrompt = visible.get((await lead()).prompt_message_id!);
    assert.ok(reviewPrompt.reply_markup.inline_keyboard.flat().some((button:any) => button.text==='Изменить ответы'));
    assert.ok(reviewPrompt.reply_markup.inline_keyboard.flat().some((button:any) => button.text==='Подтвердить и отправить'));
    aiMode = 'clarify'; aiField = 'wall_height';
    await click('send');
    assert.equal((await lead()).status,'collecting');
    assert.equal((await lead()).step,'wall_height');
    assert.equal((await lead()).ai_approved,false);
    aiMode = 'accept';
    await message('6,2');
    assert.equal((await lead()).step,'review');
    delete process.env.AI_API_KEY;
    await click('send');
    assert.equal((await lead()).status,'collecting');
    process.env.AI_API_KEY = 'offline-ai-fixture';
    aiMode = 'unavailable';
    await click('send');
    assert.equal((await lead()).status,'collecting');
    assert.ok(!calls.some(c => c.method==='sendMessage' && [9001,9002].includes(c.payload.chat_id)));
    aiMode = 'accept';
    const beforeEdit = await lead();
    await click('edit'); await click('field_width'); await message('22,5');
    assert.equal((await lead()).step,'review'); assert.equal((await lead()).width,'22.5');
    await click('send',beforeEdit); assert.equal((await lead()).status,'collecting');
    const ready = await lead();
    // Failed first manager notification must retain existing fallback distribution.
    failManager = true;
    await Promise.all([click('send',ready),click('send',ready)]);
    const sent = await lead(); assert.equal(sent.ai_approved,true); assert.equal(sent.status,'notified'); assert.equal(sent.assigned_manager_id,'9002');
    const notifications = calls.filter(c => c.method==='sendMessage' && c.payload.chat_id===9002);
    assert.equal(notifications.length,1);
    const notice = notifications[0].payload.text;
    for (const part of ['Москва','22.5 м','40 м','6.2 м','Утеплённый','Александр','+79991234567','@client_test','Назначение:','rv-267087']) assert.ok(notice.includes(part),part);
    assert.ok(!notice.includes('Сроки'));
    // The lead goes to a single manager with no accept/decline buttons.
    assert.equal(notifications[0].payload.reply_markup,undefined);
    // Direct chat supports request_contact and own contact submission.
    await message('/request',undefined,false);
    assert.equal(await db.findLead('',42),null);
    await message(trigger,undefined,false);
    failFirstGreeting = true;
    await expireEntry(false); await startDueConversations(bot);
    assert.equal((await db.findLead('',42))?.prompt_message_id,null);
    await expireEntry(false); await startDueConversations(bot);
    const direct = await db.findLead('',42); assert.ok(direct);
    missingPrompt = true;
    // "Другое" switches the purpose question to free text; the custom value is
    // stored through the real handler and database, not the literal label.
    await click('other',direct);
    const awaitingCustom = await db.findLead('',42);
    assert.equal(awaitingCustom?.awaiting_custom,true);
    assert.equal(awaitingCustom?.purpose,null);
    assert.ok(visible.get(awaitingCustom!.prompt_message_id!).text.includes('своими словами'));
    await message('Хранение лодок',undefined,false);
    assert.equal((await db.findLead('',42))?.purpose,'Хранение лодок');
    assert.equal((await db.findLead('',42))?.awaiting_custom,false);
    assert.equal((await db.findLead('',42))?.step,'city');
    assert.notEqual((await db.findLead('',42))?.prompt_message_id,direct.prompt_message_id);
    await db.pool.query(`UPDATE leads SET step='phone' WHERE id=$1`,[direct.id]);
    await message('/resume',undefined,false);
    const contactButton = calls.filter(c => c.method==='sendMessage' && c.payload.reply_markup?.keyboard?.[0]?.[0]?.request_contact).at(-1)?.payload.reply_markup.keyboard[0][0];
    assert.equal(contactButton?.text,'Поделиться контактом');
    await message(undefined,{phone_number:'79997654321',first_name:'Клиент',user_id:42},false);
    const directReview = await db.findLead('',42);
    assert.equal(directReview?.phone,'+79997654321');
    const directVisible = [...visible.values()].filter(msg => msg.chat_id===42 && !msg.business_connection_id);
    assert.equal(directVisible.length,1);
    assert.ok(visible.get(directReview!.prompt_message_id!).reply_markup.inline_keyboard.flat().some((button:any) => button.text==='Изменить ответы'));
    assert.ok(calls.some(c => c.method==='deleteMessage'));
    // Unsupported business keyboards switch to persistent, label-based fallback.
    await db.pool.query(`UPDATE leads SET status='cancelled' WHERE id=$1`,[sent.id]);
    failKeyboard = true; await message('/new');
    assert.equal((await lead()).text_choices,true);
    await message('Склад'); assert.equal((await lead()).step,'city');
    const revision = (await lead()).revision;
    await message('Москва',undefined,true,messageId); // replay of the last input
    assert.equal((await lead()).revision,revision);
    // The lead goes to a single manager and stays with them: a delivered
    // (notified) lead is terminal and is never reassigned, regardless of age or
    // the Moscow calendar day. Only a dispatch left stuck by a crash is reclaimed.
    const {dispatchOne} = await import('../src/dispatch.js');
    failManager = false;
    async function seedLead(connectionId:string, chatId:number, patch:string) {
      const {lead:item} = await db.createLead({connectionId,chatId,userId:chatId,name:'Test',messageId:1});
      await db.pool.query(`UPDATE leads SET consent=TRUE,ai_approved=TRUE,purpose='Склад',city='Казань',width=20,length=30,wall_height=6,insulation='Холодный',contact_name='Иван',phone='+79991234567',${patch} WHERE id=$1`,[item.id]);
      return item.id;
    }
    const kept = await seedLead('keep',1001,`status='notified',notified_at=now()-interval '2 days',assigned_manager_id=9001,tried_manager_ids='{9001}'`);
    const accepted = await seedLead('acc',1004,`status='accepted',assigned_manager_id=9001,tried_manager_ids='{9001}'`);
    const fresh = await seedLead('fresh',1009,`status='dispatching',assigned_manager_id=9001,tried_manager_ids='{9001}'`);
    const stuck = await seedLead('stuck',1008,`status='dispatching',assigned_manager_id=9001,tried_manager_ids='{9001}',updated_at=now()-interval '10 minutes'`);
    await db.recycleExpired();
    assert.equal((await db.getLead(kept))?.status,'notified'); // Never taken from its manager.
    assert.equal((await db.getLead(accepted))?.status,'accepted');
    assert.equal((await db.getLead(fresh))?.status,'dispatching'); // Recent: still in flight.
    assert.equal((await db.getLead(stuck))?.status,'queued'); // Crash-stuck: reclaimed.
    assert.equal((await db.getLead(stuck))?.assigned_manager_id,null);
    assert.deepEqual((await db.getLead(stuck))?.tried_manager_ids,[]); // Can be re-delivered to the same manager.
    // No available managers left: the lead needs attention and the admin is alerted.
    const {lead:exhausted} = await db.createLead({connectionId:'exhausted',chatId:1007,userId:1007,name:'Test',messageId:1});
    await db.pool.query(`UPDATE leads SET status='queued',consent=TRUE,ai_approved=TRUE,purpose='Склад',city='Казань',width=20,length=30,wall_height=6,insulation='Холодный',contact_name='Иван',phone='+79991234567',tried_manager_ids='{9001,9002}' WHERE id=$1`,[exhausted.id]);
    await dispatchOne(bot,exhausted.id);
    assert.equal((await db.getLead(exhausted.id))?.status,'needs_attention');
    assert.equal((await db.getLead(exhausted.id))?.assigned_manager_id,null);
    assert.ok(calls.some(c => c.method==='sendMessage' && c.payload.chat_id===7000 && c.payload.text.includes(`#${exhausted.id}`)));

    // Dispatcher cannot bypass semantic approval, including legacy queued rows.
    const {lead:unchecked} = await db.createLead({connectionId:'unchecked-ai',chatId:1005,userId:1005,name:'Test',messageId:1});
    await db.pool.query(`UPDATE leads SET status='queued',consent=TRUE,purpose='Склад',city='Продам велосипед',width=20,length=30,wall_height=6,insulation='Холодный',contact_name='Александр',phone='+79991234567' WHERE id=$1`,[unchecked.id]);
    assert.equal(await db.claimLeadDispatch(unchecked.id,'9001'),null);
    aiMode = 'unavailable';
    await dispatchOne(bot,unchecked.id);
    assert.equal((await db.getLead(unchecked.id))?.status,'queued');
    aiMode = 'clarify'; aiField = 'city';
    await dispatchOne(bot,unchecked.id);
    assert.equal((await db.getLead(unchecked.id))?.status,'collecting');
    assert.equal((await db.getLead(unchecked.id))?.step,'city');
    assert.equal((await db.getLead(unchecked.id))?.consent,false);
    const {lead:noConsent} = await db.createLead({connectionId:'no-consent',chatId:1006,userId:1006,name:'Test',messageId:1});
    await db.pool.query(`UPDATE leads SET status='queued',ai_approved=TRUE,purpose='Склад',city='Казань',width=20,length=30,wall_height=6,insulation='Холодный',contact_name='Александр',phone='+79991234567' WHERE id=$1`,[noConsent.id]);
    assert.equal(await db.claimLeadDispatch(noConsent.id,'9001'),null);
    await dispatchOne(bot,noConsent.id);
    assert.equal((await db.getLead(noConsent.id))?.status,'collecting');
    assert.equal((await db.getLead(noConsent.id))?.step,'review');
    assert.equal((await db.getLead(noConsent.id))?.ai_approved,false);
    // Reset is allowlisted and scoped to the caller's current test chat.
    const preservedDirect = await db.findLead('',42);
    const oldTest = await lead();
    await db.pool.query(`UPDATE leads SET status='accepted' WHERE id=$1`,[oldTest.id]);
    await bot.handleUpdate({update_id:++updateId,message:{message_id:1,date:1,chat:{id:43,type:'private'},from:{id:43,is_bot:false,first_name:'Other'},text:'/test_reset'}} as any);
    assert.equal((await lead()).id,oldTest.id);
    assert.ok(calls.some(c => c.method==='sendMessage' && c.payload.chat_id===43 && c.payload.text.includes('тестовым аккаунтам')));
    await message('/test_version');
    assert.equal((await lead()).id,oldTest.id);
    assert.ok(calls.some(c => c.method==='sendMessage' && c.payload.text==='Версия бота: tentmax-review-edit-1'));
    await message('/test_id');
    assert.equal((await lead()).id,oldTest.id);
    assert.ok(calls.some(c => c.method==='sendMessage' && c.payload.text.includes('Ваш Telegram ID: 42')));
    await message('/test_reset');
    const resetMessageId = messageId;
    assert.equal(await db.findLead('business-test',42),null);
    assert.equal((await db.findLead('',42))?.id,preservedDirect?.id);
    assert.equal((await db.getLead(accepted))?.status,'accepted'); // Another client untouched.
    await click('warehouse',oldTest);
    assert.equal(await db.findLead('business-test',42),null);
    await message('Здравствуйте');
    await expireEntry(); await startDueConversations(bot);
    assert.equal(await db.findLead('business-test',42),null);
    await message(trigger);
    await expireEntry(); await startDueConversations(bot);
    const newTest = await lead();
    assert.notEqual(newTest.id,oldTest.id);
    assert.equal(newTest.city,null);
    assert.equal(newTest.ai_approved,false);
    await message('/test_reset',undefined,true,resetMessageId); // Replayed reset cannot delete a new form.
    assert.equal((await lead()).id,newTest.id);
    await click('warehouse',oldTest); // Old client keyboard cannot update the new ID.
    assert.equal((await lead()).step,'purpose');
    await message('/test_reset');
    await message(trigger); // A reset also cancels an entry still waiting for silence.
    await expireEntry();
    const pendingTest = (await db.dueEntries()).find(entry => entry.chat_id==='42' && entry.business_connection_id==='business-test');
    assert.ok(pendingTest);
    await message('/test_reset');
    assert.equal(await db.activateEntry(pendingTest),null);
    assert.equal(await db.findLead('business-test',42),null);
    // Direct reset removes the phone reply keyboard and leaves other chats intact.
    await message('/test_reset',undefined,false);
    assert.equal(await db.findLead('',42),null);
    assert.ok(calls.some(c => c.method==='sendMessage' && c.payload.text.includes('Тестовая анкета') && c.payload.reply_markup?.remove_keyboard));
    for (const request of aiRequests) {
      const fields = JSON.parse(request.messages[1].content);
      for (const privateField of ['phone','client_telegram_id','client_username','first_message']) assert.equal(fields[privateField],undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await db.pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
