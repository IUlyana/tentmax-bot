import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSemantics, semanticInput } from '../src/ai.js';
import type { Lead } from '../src/db.js';

function response(content:unknown,finish_reason='stop') {
  return Response.json({choices:[{finish_reason,message:{content:JSON.stringify(content)}}]});
}
test('AI request uses strict JSON and sends only the necessary fields',async () => {
  let calls=0;
  const fetchMock: typeof fetch = async (url,options) => {
    calls++;
    assert.equal(url,'https://api.openai.com/v1/chat/completions');
    const body=JSON.parse(options!.body as string);
    assert.equal(body.store,false);
    assert.equal(body.response_format.json_schema.strict,true);
    assert.equal(body.model,'gpt-4.1-mini');
    const fields=JSON.parse(body.messages[1].content);
    assert.deepEqual(fields,{city:'Казань'});
    return response({decision:'accept',field:null});
  };
  assert.deepEqual(await checkSemantics({city:'Казань',phone:'+79991234567'} as any,{apiKey:'test',fetch:fetchMock}),{decision:'accept',field:null});
  assert.equal(calls,1);
});
test('AI clarification keeps only an allowed field present in the request',async () => {
  const input={city:'Продам велосипед'};
  assert.deepEqual(await checkSemantics(input,{apiKey:'test',fetch:async () => response({decision:'clarify',field:'city'})}),{decision:'clarify',field:'city'});
  for (const verdict of [{decision:'accept',field:'city'},{decision:'clarify',field:'phone'},{decision:'clarify',field:'contact_name'},{decision:'accept',field:null,action:'send'},{decision:'send',field:null},null]) {
    assert.equal((await checkSemantics(input,{apiKey:'test',fetch:async () => response(verdict)})).decision,'unavailable');
  }
});
test('missing credentials, HTTP errors, malformed JSON, refusal and truncation never approve',async () => {
  let calls=0;
  assert.equal((await checkSemantics({city:'Тула'},{apiKey:'',fetch:async () => {calls++;return response({decision:'accept',field:null});}})).decision,'unavailable');
  assert.equal(calls,0);
  for (const status of [401,429,500,503]) assert.equal((await checkSemantics({city:'Тула'},{apiKey:'test',fetch:async () => new Response('{}',{status})})).decision,'unavailable');
  for (const fetchMock of [
    async () => new Response('not JSON'),
    async () => Response.json({choices:[{finish_reason:'stop',message:{refusal:'refused'}}]}),
    async () => response({decision:'accept',field:null},'length'),
    async () => {throw new Error('network failure');},
  ]) assert.equal((await checkSemantics({city:'Тула'},{apiKey:'test',fetch:fetchMock})).decision,'unavailable');
});
test('AI requests have a timeout and cannot hang the conversation',async () => {
  const verdict=await checkSemantics({city:'Тула'},{apiKey:'test',timeoutMs:5,fetch:async (_url,options) => new Promise((_resolve,reject) => {
    options!.signal!.addEventListener('abort',()=>reject(new Error('timeout')),{once:true});
    // A pending mocked fetch must keep Node's test runner alive until abort.
    const timer=setTimeout(()=>reject(new Error('test did not abort')),200);
    options!.signal!.addEventListener('abort',()=>clearTimeout(timer),{once:true});
  })});
  assert.equal(verdict.decision,'unavailable');
});
test('final semantic input excludes phone and Telegram metadata',() => {
  const fields=semanticInput({city:'Казань',contact_name:'Александр',width:'20',phone:'+79991234567',client_telegram_id:'42',client_username:'client',first_message:'private text'} as Lead);
  assert.deepEqual(fields,{city:'Казань',contact_name:'Александр',width:'20'});
});
