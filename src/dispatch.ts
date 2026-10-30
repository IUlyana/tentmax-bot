import { Bot } from 'grammy';
import { config } from './config.js';
import { checkSemantics, semanticInput, clarification } from './ai.js';
import { summary, firstInvalidField } from './qualification.js';
import { pool, type Lead, claimLeadDispatch, dispatchFailed, getLead, pendingLeads, recycleExpired, selectManager, setNeedsAttention, setNotified } from './db.js';

export function renderLead(lead: Lead): string {
  const username = lead.client_username ? `@${lead.client_username} — https://t.me/${lead.client_username}` : 'не установлен';
  return [
    `📥 Новая заявка TENTMAX #${lead.id}`,
    ...(lead.request_code ? [`Номер обращения: ${lead.request_code}`] : []),
    summary(lead),
    `Telegram: ${username}`,
    `Telegram ID: ${lead.client_telegram_id}`,
    `Согласие на передачу: ${lead.consent ? 'получено' : 'не получено'}`,
    'Свяжитесь с клиентом напрямую по указанному контакту.',
    ...(!lead.purpose ? [`Архивная заявка: ${lead.service ?? '—'}; ${lead.description ?? '—'}; бюджет: ${lead.budget ?? '—'}`, `Имя Telegram: ${lead.client_name}`] : []),
  ].join('\n');
}

let dispatching = false;

export async function dispatchOne(bot: Bot, leadId: string): Promise<void> {
  let current = await getLead(leadId);
  if (current?.status === 'queued' && (!current.ai_approved || !current.consent)) {
    // Also protect the dispatcher against legacy or manually queued drafts.
    const invalidField = firstInvalidField(current);
    const verdict = invalidField || !current.consent ? null : await checkSemantics(semanticInput(current));
    if (verdict?.decision === 'unavailable') return;
    const correction = invalidField ?? (!current.consent ? 'review' : null) ?? (verdict?.decision === 'clarify' ? verdict.field : null);
    if (correction) {
      const {rows} = await pool.query<Lead>(`UPDATE leads SET status='collecting',step=$3,resume_step='review',
        consent=FALSE,ai_approved=FALSE,attempts=0,stopped=FALSE,awaiting_custom=FALSE,revision=revision+1,assigned_manager_id=NULL,updated_at=now()
        WHERE id=$1 AND revision=$2 AND status='queued' RETURNING *`,[current.id,current.revision,correction]);
      if (rows[0]) {
        const {sendPrompt} = await import('./conversation.js');
        await sendPrompt(bot,rows[0],verdict?.decision === 'clarify' ? clarification(verdict.field) : 'Уточните, пожалуйста, данные перед отправкой заявки.');
      }
      return;
    }
    const {rows} = await pool.query<Lead>(`UPDATE leads SET ai_approved=TRUE WHERE id=$1 AND revision=$2 AND status='queued' RETURNING *`,[current.id,current.revision]);
    current = rows[0] ?? null;
  }
  while (current?.status === 'queued') {
    const manager = await selectManager(current.tried_manager_ids);
    if (!manager) {
      await setNeedsAttention(leadId);
      await alertAdmin(bot, `⚠️ Заявка #${leadId} не назначена: нет доступных менеджеров или все попытки доставки не удались.`);
      return;
    }
    const locked = await claimLeadDispatch(leadId, manager.telegram_id);
    if (!locked) return;
    try {
      await bot.api.sendMessage(Number(manager.telegram_id), renderLead(locked));
      await setNotified(leadId);
      return;
    } catch (error) {
      // Most common reason: manager didn't start this bot yet.
      console.error(`Manager ${manager.telegram_id} notification failed:`, error instanceof Error ? error.message : 'Unknown error');
      await dispatchFailed(leadId);
      current = await getLead(leadId);
    }
  }
}

export async function dispatchQueued(bot: Bot): Promise<void> {
  if (dispatching) return;
  dispatching = true;
  try {
    await recycleExpired();
    for (const lead of await pendingLeads()) {
      await dispatchOne(bot, lead.id);
    }
  } finally {
    dispatching = false;
  }
}

export async function alertAdmin(bot: Bot, text: string): Promise<void> {
  if (!config.adminId) return;
  try {
    await bot.api.sendMessage(config.adminId, text);
  } catch (error) {
    console.error('Admin alert failed:', error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function recentCounts(managerId: number): Promise<string> {
  const { rows } = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text FROM leads WHERE assigned_manager_id=$1 GROUP BY status ORDER BY status`,
    [managerId],
  );
  return rows.map((r) => `${r.status}: ${r.count}`).join('\n') || 'Нет заявок';
}
