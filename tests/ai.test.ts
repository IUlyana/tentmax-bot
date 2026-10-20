import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSemantics as rawCheckSemantics, semanticInput } from '../src/ai.js';
import type { Lead } from '../src/db.js';

const checkSemantics: typeof rawCheckSemantics = (input,options) => rawCheckSemantics(input,{onFailure:()=>{},...options});

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

test('OpenAI failure diagnostics expose status and safe codes without echoing credentials or customer data',async () => {
  const diagnostics: unknown[]=[];
  const result=await checkSemantics({city:'private customer text'},{apiKey:'private-test-key',onFailure:info=>diagnostics.push(info),fetch:async () => Response.json({error:{code:'invalid_api_key',message:'Incorrect key private-test-key; private customer text'}},{status:401})});
  assert.equal(result.decision,'unavailable');
  assert.deepEqual(diagnostics,[{reason:'http_error',status:401,code:'invalid_api_key'}]);
  assert.ok(!JSON.stringify(diagnostics).includes('private'));
});
test('API keys are trimmed before constructing the Authorization header',async () => {
  const result=await checkSemantics({city:'Москва'},{apiKey:' test-key \n',fetch:async (_url,options) => {
    assert.equal((options!.headers as Record<string,string>).Authorization,'Bearer test-key');
    return response({decision:'accept',field:null});
  }});
  assert.equal(result.decision,'accept');
});
