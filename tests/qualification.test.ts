import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choices, complete, evaluate, INSULATION, normalizeDimension, normalizePhone, ORDER, prompt, PURPOSES } from '../src/qualification.js';
import type { Lead } from '../src/db.js';

export function sample(): Lead {
  return {id:'1',business_connection_id:'business-test',client_chat_id:'42',client_telegram_id:'42',client_name:'Telegram name',client_username:'client_test',step:'purpose',status:'collecting',revision:0,resume_step:null,purpose:null,city:null,width:null,length:null,wall_height:null,insulation:null,contact_name:null,deadline:null,phone:null,consent:false} as Lead;
}
function answer(lead: Lead, text='', action?:string, contact?:string): Lead {
  const result = evaluate(lead,text,action,contact);
  assert.equal(result.ok,true,JSON.stringify(result));
  if (!result.ok) throw Error(result.reply);
  return {...lead,...result.update,revision:lead.revision+1};
}
test('complete TENTMAX dialogue collects every field and requires explicit submission',() => {
  let lead = sample();
  lead = answer(lead,'','warehouse');
  assert.equal(lead.step,'city');
  for (const text of ['Казань','18,5','40','6,2']) lead = answer(lead,text);
  lead = answer(lead,'','insulated');
  for (const text of ['В сентябре','Александр','+7 (999) 123-45-67']) lead = answer(lead,text);
  assert.equal(lead.step,'review'); assert.equal(lead.status,'collecting'); assert.equal(lead.consent,false);
  assert.equal(complete(lead),true); assert.equal(lead.width,'18.5'); assert.equal(lead.wall_height,'6.2');
  assert.equal(lead.insulation,INSULATION.insulated); assert.equal(lead.purpose,PURPOSES.warehouse);
  assert.match(prompt(lead),/Александр/); assert.match(prompt(lead),/18.5 м/);
  lead = answer(lead,'','send'); assert.equal(lead.status,'queued'); assert.equal(lead.consent,true);
});
test('dimensions accept decimal separators, reject invalid, negative and non-finite input',() => {
  for (const raw of ['0','-1','NaN','Infinity','1e3','12 метров','1,2,3','', '9'.repeat(400)]) assert.equal(normalizeDimension(raw),null,raw);
  for (const raw of ['12','12.5','12,5','0.1',' 00012,50 ']) assert.ok(normalizeDimension(raw),raw);
  assert.equal(evaluate({...sample(),step:'width'},'0').ok,false);
});
test('choices require buttons; all purposes and insulation options work',() => {
  assert.equal(evaluate(sample(),'1').ok,false);
  for (const key of Object.keys(PURPOSES)) assert.equal(answer(sample(),'',key).purpose,PURPOSES[key as keyof typeof PURPOSES]);
  for (const key of Object.keys(INSULATION)) assert.equal(answer({...sample(),step:'insulation'},'',key).insulation,INSULATION[key as keyof typeof INSULATION]);
  assert.equal(choices({...sample(),step:'insulation'}).length,4);
});
test('editing one field returns to interrupted step and keeps other answers',() => {
  let lead = {...sample(),step:'length' as const,city:'Москва',width:'20'} as Lead;
  lead = answer(lead,'','edit'); lead = answer(lead,'','field_city'); lead = answer(lead,'Тула');
  assert.equal(lead.city,'Тула'); assert.equal(lead.width,'20'); assert.equal(lead.step,'length');
  lead = answer({...lead,step:'review'},'','edit'); lead = answer(lead,'','field_width'); lead = answer(lead,'25,5');
  assert.equal(lead.step,'review'); assert.equal(lead.width,'25.5');
});
test('phone is required, supports manual input and own-contact payload',() => {
  const lead = {...sample(),step:'phone' as const};
  assert.equal(evaluate(lead,'пропустить').ok,false); assert.equal(normalizePhone('123'),null);
  assert.equal(answer(lead,'',undefined,'79991234567').phone,'+79991234567');
  assert.equal(answer(lead,'+7 (999) 123-45-67').step,'review');
});
test('city, name, deadlines validate input and review cannot send incomplete data',() => {
  for (const step of ['city','contact_name'] as const) assert.equal(evaluate({...sample(),step},'123').ok,false);
  assert.equal(evaluate({...sample(),step:'review'},'да').ok,false);
  assert.equal(evaluate({...sample(),step:'review'},'','send').ok,false);
  assert.equal(answer({...sample(),step:'review'},'','cancel').status,'cancelled');
  assert.equal(answer({...sample(),step:'deadline'},'01.06.2027').deadline,'01.06.2027');
  assert.equal(ORDER.length,9);
});
