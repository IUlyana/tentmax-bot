import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryCode } from '../src/entry-message.js';

const trigger = 'Обязательно отправьте это сообщение и дождитесь ответа. Ваш номер: rv-267087';
test('entry requires the entire trigger message and accepts individual request numbers', () => {
  assert.equal(entryCode(trigger),'rv-267087');
  assert.equal(entryCode(trigger.replace('267087','98123')),'rv-98123');
  assert.equal(entryCode(`  ${trigger}\n`),'rv-267087');
  for (const text of ['Здравствуйте','/start','/request','rv-267087',`${trigger}\nДополнение`,`Привет ${trigger}`,trigger.replace('rv-267087','rv-abc')]) assert.equal(entryCode(text),null,text);
});
