import { startDueConversations } from './entry.js';
import { createBot } from './bot.js';
import { initDb, pool } from './db.js';
import { dispatchQueued } from './dispatch.js';

const bot = createBot();

async function main(): Promise<void> {
  await initDb();
  // One process only: bot.start uses long polling. Stop any webhook before switching to polling.
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  await dispatchQueued(bot);
  const timer = setInterval(() => {
    void dispatchQueued(bot).catch((err) => console.error('Dispatch worker error:', err instanceof Error ? err.message : String(err)));
  }, 30_000);
  timer.unref();
  // Give long polling time to consume messages queued during downtime before
  // resuming persisted greetings. Never greet from a stale pre-poll snapshot.
  let entryTimer: ReturnType<typeof setInterval> | undefined;
  const entryWarmup = setTimeout(() => {
    entryTimer = setInterval(() => {
      void startDueConversations(bot).catch(err => console.error('Conversation start worker error:', err instanceof Error ? err.message : String(err)));
    }, 5_000);
    entryTimer.unref();
  }, 180_000);
  entryWarmup.unref();
  process.once('SIGINT', () => { clearInterval(timer); clearInterval(entryTimer); clearTimeout(entryWarmup); void bot.stop(); });
  process.once('SIGTERM', () => { clearInterval(timer); clearInterval(entryTimer); clearTimeout(entryWarmup); void bot.stop(); });
  console.info('Lead qualification bot started');
  await bot.start({ allowed_updates: ['business_connection', 'business_message', 'message', 'callback_query'] });
  await pool.end();
}

main().catch((error: unknown) => {
  console.error('Startup error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
