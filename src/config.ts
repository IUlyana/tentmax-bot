import 'dotenv/config';

export interface ManagerConfig {
  id: number;
  name: string;
  username: string;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

function loadManagers(): ManagerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(required('MANAGERS_JSON'));
  } catch {
    throw new Error('MANAGERS_JSON must be a valid JSON array');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('MANAGERS_JSON needs at least one manager');
  }
  const managers: ManagerConfig[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') throw new Error('Invalid manager object');
    const m = item as Record<string, unknown>;
    if (typeof m.id !== 'number' || !Number.isSafeInteger(m.id) || m.id <= 0 || typeof m.name !== 'string' || !m.name.trim()) {
      throw new Error('Each manager must have a numeric Telegram ID and name');
    }
    if (typeof m.username !== 'string' || !/^[a-zA-Z0-9_]{5,32}$/.test(m.username.replace(/^@/, ''))) {
      throw new Error('Manager username must be a valid Telegram username');
    }
    managers.push({ id: m.id, name: m.name.trim(), username: m.username.replace(/^@/, '') });
  }
  if (new Set(managers.map((m) => m.id)).size !== managers.length) throw new Error('Duplicate manager IDs');
  return managers;
}

const adminString = process.env.ADMIN_TELEGRAM_ID?.trim();
if (adminString && !/^\d+$/.test(adminString)) throw new Error('ADMIN_TELEGRAM_ID must be numeric');

const testerIds = (process.env.TESTER_TELEGRAM_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
if (testerIds.some(value => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
  throw new Error('TESTER_TELEGRAM_IDS must contain comma-separated numeric Telegram IDs');
}

export const config = {
  token: required('BOT_TOKEN'),
  databaseUrl: required('DATABASE_URL'),
  managers: loadManagers(),
  adminId: adminString ? Number(adminString) : undefined,
  testerIds: new Set(testerIds.map(Number)),
};
