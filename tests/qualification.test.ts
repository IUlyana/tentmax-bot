import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from '../src/qualification.js';
import type { Lead } from '../src/db.js';

const sample = { client_username: 'client_example' } as Lead;

test('service choice is mapped', () => {
  const answer = evaluate('service', '2', sample);
  assert.equal(answer.ok, true);
  if (answer.ok) assert.equal(answer.update.service, 'Интернет-магазин');
});

test('meaningless description is rejected', () => {
  const answer = evaluate('description', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sample);
  assert.equal(answer.ok, false);
});

test('adequate description is accepted', () => {
  const answer = evaluate('description', 'Нужен интернет-магазин мебели с оплатой онлайн', sample);
  assert.equal(answer.ok, true);
  if (answer.ok) assert.equal(answer.next, 'budget');
});

test('phone can be omitted when Telegram username exists', () => {
  const answer = evaluate('phone', 'пропустить', sample);
  assert.equal(answer.ok, true);
});

test('invalid phone is rejected', () => {
  const answer = evaluate('phone', '123', sample);
  assert.equal(answer.ok, false);
});

test('consent is explicit', () => {
  assert.equal(evaluate('consent', 'да', sample).ok, true);
  assert.equal(evaluate('consent', 'может быть', sample).ok, false);
});
