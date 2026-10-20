import type { Lead, Step } from './db.js';

export const PURPOSES = { warehouse: 'Склад', production: 'Производство', sport: 'Спортивный объект', agriculture: 'Сельское хозяйство', other: 'Другое' };
export const INSULATION = { warm: 'Тёплый (2 слоя тента)', cold: 'Холодный', insulated: 'Утеплённый (2 слоя тента + утеплитель)', advice: 'Нужна консультация' };
export const FIELDS = { purpose: 'Назначение', city: 'Город или регион', width: 'Ширина', length: 'Длина', wall_height: 'Высота прямой стены', insulation: 'Тип ангара', contact_name: 'Имя', phone: 'Телефон' };
export type Field = keyof typeof FIELDS;
export const ORDER = Object.keys(FIELDS) as Field[];
export type Changes = Partial<Pick<Lead, Field | 'step' | 'status' | 'consent' | 'resume_step'>>;
export type AnswerResult = { ok: true; update: Changes } | { ok: false; reply: string };
export const START_QUESTION = 'Здравствуйте! Вы обратились в TENTMAX. Поможем подобрать тентовое сооружение под вашу задачу. Для чего планируете использовать ангар?';

export function summary(lead: Lead): string {
  return ORDER.map(field => `${FIELDS[field]}: ${lead[field] ?? '—'}${['width','length','wall_height'].includes(field) && lead[field] ? ' м' : ''}`).join('\n');
}

export function prompt(lead: Lead): string {
  const prompts: Record<Step, string> = {
    purpose: START_QUESTION,
    city: 'В каком городе или регионе планируете установить ангар?',
    width: 'Какая нужна ширина ангара? Укажите в метрах, например 18 или 18,5.',
    length: 'Какой длины нужен ангар? Укажите в метрах.',
    wall_height: 'Какая нужна высота прямой стены — от земли до начала ската крыши? Укажите в метрах.',
    insulation: 'Какой вариант ангара рассматриваете?',
    contact_name: 'Как к вам обращаться?',
    phone: 'Оставьте номер телефона, по которому менеджер сможет обсудить с вами проект. Например, +79991234567.',
    review: `Проверьте, пожалуйста, данные:\n\n${summary(lead)}\n\nМожно изменить любой ответ. Отправляя заявку, вы соглашаетесь передать эти данные и ваш Telegram-контакт менеджеру TENTMAX для обсуждения проекта.`,
    edit: 'Что хотите изменить?',
    done: lead.status === 'cancelled' ? 'Заявка не отправлена. Если захотите вернуться к обсуждению, напишите /new.' : 'Спасибо! Передали вашу заявку менеджеру TENTMAX. Он свяжется с вами, чтобы обсудить детали.',
  };
  return prompts[lead.step];
}

export function choices(lead: Lead): [string,string][] {
  if (lead.step === 'purpose') return Object.entries(PURPOSES).map(([key,label]) => [label, key]);
  if (lead.step === 'insulation') return Object.entries(INSULATION).map(([key,label]) => [label, key]);
  if (lead.step === 'review') return [['Отправить заявку', 'send'], ['Изменить данные', 'edit'], ['Не отправлять', 'cancel']];
  if (lead.step === 'edit') return [...ORDER.map((field): [string,string] => [FIELDS[field], `field_${field}`]), ['Вернуться', 'resume']];
  return [];
}

export function normalizeDimension(raw: string): string | null {
  const value = raw.trim().replace(',', '.');
  if (value.length > 64 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  // NUMERIC in PostgreSQL is exact, while validation must reject overflow/underflow.
  return Number.isFinite(n) && n > 0 ? value.replace(/^0+(?=\d)/, '') : null;
}
export function normalizePhone(raw: string): string | null {
  const value = raw.trim().replace(/[\s()\-]/g, '');
  return /^\+?[1-9]\d{9,14}$/.test(value) ? (value.startsWith('+') ? value : `+${value}`) : null;
}
export function complete(lead: Lead): boolean {
  return ORDER.every(field => typeof lead[field] === 'string' && !!lead[field]?.trim())
    && !!normalizeDimension(lead.width ?? '') && !!normalizeDimension(lead.length ?? '') && !!normalizeDimension(lead.wall_height ?? '')
    && !!normalizePhone(lead.phone ?? '')
    && Object.values(PURPOSES).some(value => value === lead.purpose) && Object.values(INSULATION).some(value => value === lead.insulation);
}

export function evaluate(lead: Lead, raw: string, action?: string, contactPhone?: string): AnswerResult {
  const text = raw.trim();
  const fail = (reply: string): AnswerResult => ({ok:false,reply});
  if (action === 'edit' || text.toLowerCase() === '/edit') {
    return {ok:true,update:{step:'edit',resume_step:lead.resume_step ?? lead.step}};
  }
  if (lead.step === 'edit') {
    if (action === 'resume') return {ok:true,update:{step:lead.resume_step ?? 'purpose',resume_step:null}};
    const field = action?.replace(/^field_/, '') as Field;
    return ORDER.includes(field) ? {ok:true,update:{step:field}} : fail('Выберите поле, которое хотите изменить.');
  }
  if (lead.step === 'review') {
    if (action === 'cancel') return {ok:true,update:{status:'cancelled',step:'done',consent:false,resume_step:null}};
    if (action === 'send' && complete(lead)) return {ok:true,update:{status:'queued',step:'done',consent:true,resume_step:null}};
    return fail('Пожалуйста, проверьте данные и выберите действие под заявкой.');
  }
  if (!ORDER.includes(lead.step as Field)) return fail('Эта заявка уже обработана.');
  const field = lead.step as Field;
  let value: string | null = text;
  if (field === 'purpose' || field === 'insulation') {
    const options: Record<string,string> = field === 'purpose' ? PURPOSES : INSULATION;
    value = action && Object.hasOwn(options, action) ? options[action] : null;
    if (!value) return fail('Пожалуйста, выберите подходящий вариант.');
  } else if (['width','length','wall_height'].includes(field)) {
    value = normalizeDimension(text);
    if (!value) return fail('Укажите положительное число в метрах, например 12 или 12,5.');
  } else if (field === 'phone') {
    value = normalizePhone(contactPhone ?? text);
    if (!value) return fail('Проверьте номер: нужен международный формат, например +79991234567. Можно ввести его вручную.');
  } else if (field === 'contact_name') {
    if (text.length < 2 || text.length > 100 || !/\p{L}/u.test(text) || /[\d\n\r]/.test(text)) return fail('Подскажите ваше имя, пожалуйста. Например, Александр.');
  } else if (text.length < 2 || text.length > 200 || !/\p{L}/u.test(text) || /[\n\r]/.test(text)) {
    return fail('Уточните город или регион установки, пожалуйста.');
  }
  const next = lead.resume_step && lead.resume_step !== field ? lead.resume_step : ORDER[ORDER.indexOf(field) + 1] ?? 'review';
  return {ok:true,update:{[field]:value,step:next,resume_step:null,consent:false}};
}
