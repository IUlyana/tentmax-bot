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
  process.env.BOT_TOKEN = '123456789:offline_test_token';
  process.env.MANAGERS_JSON = JSON.stringify([{id:9001,name:'Менеджер',username:'manager_test'},{id:9002,name:'Второй',username:'manager_second'}]);
  const db = await import('../src/db.js');
  const {createBot} = await import('../src/bot.js');
  const {readFileSync} = await import('node:fs');
  const {callbackData} = await import('../src/conversation.js');
  const calls: {method:string;payload:any}[] = [];
  let outgoingId = 1000;
  let updateId = 0;
  let failKeyboard = false;
  let failManager = false;
  function makeBot() {
    const bot = createBot();
    bot.botInfo = {id:123456789,is_bot:true,first_name:'TENTMAX',username:'tentmax_test_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false,can_connect_to_business:true,has_main_web_app:false};
    bot.api.config.use(async (_prev,method,payload:any) => {
      calls.push({method,payload});
      if (method === 'getBusinessConnection') return {ok:true,result:{id:'business-test',user:{id:1,is_bot:false,first_name:'Company'},user_chat_id:1,date:1,is_enabled:true,rights:{can_reply:true}}} as any;
      if (method === 'sendMessage') {
        if (failKeyboard && payload.business_connection_id && payload.reply_markup) return {ok:false,error_code:400,description:'Bad Request: reply markup not supported for business messages'} as any;
        if (failManager && payload.chat_id === 9001) return {ok:false,error_code:403,description:'Forbidden: bot was blocked by the user'} as any;
        return {ok:true,result:{message_id:++outgoingId,date:1,chat:{id:payload.chat_id,type:'private'},text:payload.text,business_connection_id:payload.business_connection_id}} as any;
      }
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
    await bot.handleUpdate({update_id:++updateId,callback_query:{id:String(updateId),from:{...from,id:actor},chat_instance:'test',data:callbackData(current,action),message:{message_id:outgoingId,date:1,chat:{id:42,type:'private'},...(current.business_connection_id ? {business_connection_id:current.business_connection_id} : {})}}} as any);
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
    const first = await lead();
    assert.equal(first.step,'purpose');
    assert.ok(calls.find(c => c.method==='sendMessage' && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.text==='Склад'));
    await click('warehouse',first,43); assert.equal((await lead()).revision,first.revision);
    await Promise.all([click('warehouse',first),click('production',first)]);
    assert.equal((await lead()).revision,first.revision+1);
    await click('sport',first); assert.equal((await lead()).step,'city');
    await message('Казань');
    await message('0'); assert.equal((await lead()).step,'width');
    await message('18,5');
    // Simulate process restart: nothing in memory is required to resume.
    bot = makeBot(); await message('/resume'); assert.equal((await lead()).step,'length');
    await message('40'); await message('6,2');
    await click('insulated');
    assert.equal((await lead()).step,'contact_name');
    await message('Александр');
    const phoneLead = await lead(); assert.equal(phoneLead.step,'phone');
    const phonePrompt = calls.filter(c => c.method==='sendMessage' && c.payload.text.includes('Оставьте номер')).at(-1)!;
    assert.equal(phonePrompt.payload.reply_markup?.keyboard,undefined);
    await message(undefined,{phone_number:'79991234567',first_name:'Чужой',user_id:43}); assert.equal((await lead()).step,'phone');
    await message('+7 (999) 123-45-67'); assert.equal((await lead()).step,'review');
    assert.ok(calls.some(c => c.method==='editMessageReplyMarkup' && c.payload.business_connection_id==='business-test'));
    const beforeEdit = await lead();
    await click('edit'); await click('field_width'); await message('22,5');
    assert.equal((await lead()).step,'review'); assert.equal((await lead()).width,'22.5');
    await click('send',beforeEdit); assert.equal((await lead()).status,'collecting');
    const ready = await lead();
    // Failed first manager notification must retain existing fallback distribution.
    failManager = true;
    await Promise.all([click('send',ready),click('send',ready)]);
    const sent = await lead(); assert.equal(sent.status,'notified'); assert.equal(sent.assigned_manager_id,'9002');
    const notifications = calls.filter(c => c.method==='sendMessage' && c.payload.chat_id===9002);
    assert.equal(notifications.length,1);
    const notice = notifications[0].payload.text;
    for (const part of ['Казань','22.5 м','40 м','6.2 м','Утеплённый','Александр','+79991234567','@client_test','Назначение:']) assert.ok(notice.includes(part),part);
    assert.ok(!notice.includes('Сроки'));
    assert.ok(notifications[0].payload.reply_markup.inline_keyboard[0][0].callback_data.startsWith('accept:'));
    async function managerClick(id:number,action:string) {
      await bot.handleUpdate({update_id:++updateId,callback_query:{id:String(updateId),from:{id,is_bot:false,first_name:'Менеджер'},chat_instance:'manager',data:`${action}:${sent.id}`,message:{message_id:9999,date:1,chat:{id,type:'private'}}}} as any);
    }
    await managerClick(9001,'accept'); assert.equal((await lead()).status,'notified');
    await managerClick(9002,'accept'); assert.equal((await lead()).status,'accepted');
    await managerClick(9002,'accept'); assert.equal((await lead()).status,'accepted');
    assert.ok(calls.some(c => c.method==='sendMessage' && c.payload.chat_id===42 && c.payload.business_connection_id==='business-test' && c.payload.text.includes('взял в работу')));
    // Direct chat supports request_contact and own contact submission.
    await message('/request',undefined,false);
    const direct = await db.findLead('',42); assert.ok(direct);
    await click('sport',direct);
    assert.equal((await db.findLead('',42))?.purpose,'Спортивный объект');
    await db.pool.query(`UPDATE leads SET step='phone' WHERE id=$1`,[direct.id]);
    await message('/resume',undefined,false);
    assert.ok(calls.some(c => c.method==='sendMessage' && c.payload.reply_markup?.keyboard?.[0]?.[0]?.request_contact));
    await message(undefined,{phone_number:'79997654321',first_name:'Клиент',user_id:42},false);
    assert.equal((await db.findLead('',42))?.phone,'+79997654321');
    // Unsupported business keyboards switch to persistent, label-based fallback.
    await db.pool.query(`UPDATE leads SET status='cancelled' WHERE id=$1`,[sent.id]);
    failKeyboard = true; await message('/new');
    assert.equal((await lead()).text_choices,true);
    await message('Склад'); assert.equal((await lead()).step,'city');
    const revision = (await lead()).revision;
    await message('Москва',undefined,true,messageId); // replay of the last input
    assert.equal((await lead()).revision,revision);
  } finally {
    await db.pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
