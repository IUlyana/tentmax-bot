import type { Bot } from 'grammy';
import { activateEntry, dueEntries, retryEntry, finishEntry, type Lead } from './db.js';
import { sendPrompt } from './conversation.js';

let starting = false;
export async function startDueConversations(bot: Bot): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    for (const entry of await dueEntries()) {
      let lead: Lead | null = null;
      try {
        if (entry.business_connection_id) {
          const connection = await bot.api.getBusinessConnection(entry.business_connection_id);
          if (!connection.is_enabled || !connection.rights?.can_reply || String(connection.user.id) === entry.user_id) continue;
        }
        // Claim only after permissions have been checked. Any intervening
        // message changes message_id and cancels this candidate atomically.
        lead = await activateEntry(entry);
        if (lead) {
          await sendPrompt(bot,lead);
          await finishEntry(entry);
        }
      } catch (error) {
        if (lead) await retryEntry(entry,lead.id);
        console.error('Delayed conversation start failed:',error instanceof Error ? error.message : 'Unknown error');
      }
    }
  } finally { starting = false; }
}
