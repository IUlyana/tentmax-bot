import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choices, complete, evaluate, INSULATION, normalizeDimension, normalizePhone, ORDER, prompt, PURPOSES, isRepeatedLetterNoise, firstInvalidField } from '../src/qualification.js';
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
  for (const text of ['Александр','+7 (999) 123-45-67']) lead = answer(lead,text);
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
  for (const key of Object.keys(PURPOSES).filter(k => k !== 'other')) assert.equal(answer(sample(),'',key).purpose,PURPOSES[key as keyof typeof PURPOSES]);
  for (const key of Object.keys(INSULATION)) assert.equal(answer({...sample(),step:'insulation'},'',key).insulation,INSULATION[key as keyof typeof INSULATION]);
  assert.equal(choices({...sample(),step:'insulation'}).length,4);
});
test('"Другое" lets the client type a custom purpose and keeps fixed options working',() => {
  // Clicking "Другое" switches the purpose question to free text without storing a label.
  let lead = answer(sample(),'','other');
  assert.equal(lead.awaiting_custom,true);
  assert.equal(lead.purpose,null);
  assert.equal(lead.step,'purpose');
  assert.match(prompt(lead),/своими словами/);
  // Noise is still rejected; a real description is stored and advances the form.
  assert.equal(evaluate(lead,'ggg').ok,false);
  lead = answer(lead,'Автосервис');
  assert.equal(lead.purpose,'Автосервис');
  assert.equal(lead.awaiting_custom,false);
  assert.equal(lead.step,'city');
  // A stored free-text purpose passes the completeness check.
  assert.equal(firstInvalidField({...sample(),purpose:'Автосервис',city:'Казань',width:'20',length:'30',wall_height:'6',insulation:INSULATION.cold,contact_name:'Иван',phone:'+79991234567'}),null);
  // Editing purpose can pick "Другое" again and return to the review summary.
  let edit = {...sample(),step:'review' as const,purpose:PURPOSES.warehouse} as Lead;
  edit = answer(edit,'','edit'); edit = answer(edit,'','field_purpose');
  edit = answer(edit,'','other'); assert.equal(edit.awaiting_custom,true);
  edit = answer(edit,'Ангар для техники');
  assert.equal(edit.purpose,'Ангар для техники'); assert.equal(edit.step,'review');
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
test('city and name validate input and review cannot send incomplete data',() => {
  for (const step of ['city','contact_name'] as const) assert.equal(evaluate({...sample(),step},'123').ok,false);
  assert.equal(evaluate({...sample(),step:'review'},'да').ok,false);
  assert.equal(evaluate({...sample(),step:'review'},'','send').ok,false);
  assert.equal(answer({...sample(),step:'review'},'','cancel').status,'cancelled');
  assert.equal(ORDER.length,8);
  assert.equal(answer({...sample(),step:'insulation'},'','cold').step,'contact_name');
  assert.ok(!prompt({...sample(),step:'review'}).includes('Сроки'));
  assert.ok(!choices({...sample(),step:'edit'}).some(([,action]) => action === 'field_deadline'));
});

test('correction button is offered only after the questionnaire is complete', () => {
  for (const step of ORDER) assert.ok(!choices({...sample(),step}).some(([,action]) => action === 'edit'));
  assert.deepEqual(choices({...sample(),step:'review'}).find(([,action]) => action === 'edit'),['Изменить ответы','edit']);
});

test('repeated letters cannot be accepted as a city or name, even before AI review',() => {
  for (const text of ['ggg','gggg','GGG','g g g','ааа','ААА','zzzz']) {
    assert.equal(isRepeatedLetterNoise(text),true,text);
    assert.equal(evaluate({...sample(),step:'city'},text).ok,false,text);
    assert.equal(evaluate({...sample(),step:'contact_name'},text).ok,false,text);
  }
  for (const text of ['Москва','Уфа','СПб','Мск','Ii','Александр','Ли']) assert.equal(isRepeatedLetterNoise(text),false,text);
  assert.equal(firstInvalidField({...sample(),purpose:PURPOSES.warehouse,city:'gggg'}),'city');
});
