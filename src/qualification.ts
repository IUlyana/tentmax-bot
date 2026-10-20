import type { Lead, Step } from './db.js';

export type AnswerResult =
  | { ok: true; update: Record<string, string | boolean>; next: Step; reply: string }
  | { ok: false; reply: string };

export const START_QUESTION =
  'Здравствуйте! 👋 Спасибо за обращение. Чтобы передать заявку нужному специалисту, задам несколько коротких вопросов.\n\n' +
  '1/5. Какая услуга вас интересует?\n1 — Разработка сайта\n2 — Интернет-магазин\n3 — SEO и продвижение\n4 — Другая услуга';

export function evaluate(step: Step, raw: string, lead: Lead, contactPhone?: string): AnswerResult {
  const text = raw.trim().slice(0, 2000);
  const normalized = text.toLowerCase().replace(/[.!]+$/, '').trim();

  if (step === 'service') {
    const options: Record<string, string> = {
      '1': 'Разработка сайта', '2': 'Интернет-магазин', '3': 'SEO и продвижение', '4': 'Другая услуга',
    };
    const service = options[normalized] ?? text;
    if (service.length < 3 || service.length > 120) {
      return { ok: false, reply: 'Напишите услугу или выберите номер 1–4.' };
    }
    return { ok: true, update: { service }, next: 'description', reply: '2/5. Опишите вашу задачу подробнее: что нужно сделать, какие функции важны? (Хотя бы одно-два предложения)' };
  }

  if (step === 'description') {
    if (text.length < 20 || (text.match(/[\p{L}]{2,}/gu) ?? []).length < 3 || /(.)\1{8,}/u.test(text)) {
      return { ok: false, reply: 'Пожалуйста, опишите задачу чуть подробнее — минимум 20 символов. Это поможет менеджеру подготовиться.' };
    }
    return { ok: true, update: { description: text }, next: 'budget', reply: '3/5. Какой ориентировочный бюджет? Можно ответить «пока не знаю».' };
  }

  if (step === 'budget') {
    if (text.length < 2 || text.length > 150) return { ok: false, reply: 'Укажите примерную сумму или напишите «пока не знаю».' };
    return { ok: true, update: { budget: text }, next: 'deadline', reply: '4/5. Когда планируете запуск или начало работ? Можно написать «срок пока неизвестен».' };
  }

  if (step === 'deadline') {
    if (text.length < 2 || text.length > 150) return { ok: false, reply: 'Напишите примерный срок или «пока неизвестно».' };
    const canSkip = !!lead.client_username;
    return {
      ok: true,
      update: { deadline: text },
      next: 'phone',
      reply: `5/5. Оставьте номер телефона для связи с менеджером (например +79991234567).${canSkip ? '\n\nЕсли предпочитаете связь по вашему @username, напишите «пропустить».' : '\n\nЕсли вы не хотите оставлять телефон, напишите «без телефона» — предложим ссылку на менеджера.'}`,
    };
  }

  if (step === 'phone') {
    if (contactPhone) {
      const phone = normalizePhone(contactPhone);
      if (!phone) return { ok: false, reply: 'Номер не распознан. Напишите телефон в международном формате, например +79991234567.' };
      return { ok: true, update: { phone }, next: 'consent', reply: CONSENT_QUESTION };
    }
    if (['пропустить', 'без телефона'].includes(normalized)) {
      if (!lead.client_username && normalized === 'пропустить') {
        return { ok: false, reply: 'У вашего аккаунта нет публичного @username. Напишите телефон или «без телефона», и мы предложим ссылку на менеджера.' };
      }
      return { ok: true, update: { phone: '' }, next: 'consent', reply: CONSENT_QUESTION };
    }
    const phone = normalizePhone(text);
    if (!phone) return { ok: false, reply: 'Не удалось распознать номер. Напишите телефон в формате +79991234567 или «без телефона».' };
    return { ok: true, update: { phone }, next: 'consent', reply: CONSENT_QUESTION };
  }

  if (step === 'consent') {
    if (['да', 'согласен', 'согласна', 'даю согласие'].includes(normalized)) {
      return { ok: true, update: { consent: true }, next: 'done', reply: 'Спасибо! Заявка принята, передаём её менеджеру. Он свяжется с вами, когда возьмёт её в работу.' };
    }
    return { ok: false, reply: 'Для передачи заявки менеджеру нужно ваше согласие. Ответьте «ДА» или «НЕТ».' };
  }
  return { ok: false, reply: '' };
}

export const CONSENT_QUESTION =
  'Для связи по вашей заявке мы передадим назначенному менеджеру ваше имя, Telegram-контакт, ответы на вопросы и указанный номер телефона (если есть).\n\nВы согласны? Напишите ДА или НЕТ.';

function normalizePhone(input: string): string | null {
  const stripped = input.replace(/[\s()\-]/g, '');
  if (!/^\+?\d{10,15}$/.test(stripped)) return null;
  return stripped.startsWith('+') ? stripped : `+${stripped}`;
}
