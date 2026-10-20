import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Step = 'service' | 'description' | 'budget' | 'deadline' | 'phone' | 'consent' | 'done';
export type LeadStatus = 'collecting' | 'queued' | 'dispatching' | 'notified' | 'accepted' | 'cancelled' | 'needs_attention';

export interface Lead {
  id: string;
  business_connection_id: string;
  client_chat_id: string;
  client_telegram_id: string;
  client_name: string;
  client_username: string | null;
  first_message: string | null;
  service: string | null;
  description: string | null;
  budget: string | null;
  deadline: string | null;
  phone: string | null;
  consent: boolean;
  step: Step;
  status: LeadStatus;
  assigned_manager_id: string | null;
  tried_manager_ids: string[];
  last_message_id: string;
  notified_at: Date | null;
}

export interface Manager {
  telegram_id: string;
  name: string;
  username: string | null;
  is_active: boolean;
}

export async function initDb(): Promise<void> {
  await pool.query(readFileSync(resolve(process.cwd(), 'sql/schema.sql'), 'utf8'));
  await pool.query('UPDATE managers SET is_active = FALSE');
  for (const m of config.managers) {
    await pool.query(
      `INSERT INTO managers (telegram_id, name, username, is_active) VALUES ($1,$2,$3,TRUE)
       ON CONFLICT (telegram_id) DO UPDATE SET name=EXCLUDED.name, username=EXCLUDED.username, is_active=TRUE`,
      [m.id, m.name, m.username ?? null],
    );
  }
}

export async function findLead(connectionId: string, chatId: number): Promise<Lead | null> {
  const { rows } = await pool.query<Lead>('SELECT * FROM leads WHERE business_connection_id=$1 AND client_chat_id=$2', [connectionId, chatId]);
  return rows[0] ?? null;
}

export async function createLead(data: {
  connectionId: string;
  chatId: number;
  userId: number;
  name: string;
  username?: string;
  firstMessage?: string;
  messageId: number;
}): Promise<{ lead: Lead; created: boolean }> {
  const { rows } = await pool.query<Lead>(
    `INSERT INTO leads (business_connection_id,client_chat_id,client_telegram_id,client_name,client_username,first_message,last_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (business_connection_id,client_chat_id) DO NOTHING RETURNING *`,
    [data.connectionId, data.chatId, data.userId, data.name, data.username ?? null, data.firstMessage ?? null, data.messageId],
  );
  if (rows[0]) return { lead: rows[0], created: true };
  const lead = await findLead(data.connectionId, data.chatId);
  if (!lead) throw new Error('Lead not found after upsert');
  return { lead, created: false };
}

// Guards against Telegram redelivery and repeated message processing.
export async function claimMessage(leadId: string, messageId: number, username: string | undefined, name: string): Promise<Lead | null> {
  const { rows } = await pool.query<Lead>(
    `UPDATE leads SET last_message_id=$2, client_username=COALESCE($3,client_username), client_name=$4, updated_at=now()
     WHERE id=$1 AND last_message_id < $2 RETURNING *`,
    [leadId, messageId, username ?? null, name],
  );
  return rows[0] ?? null;
}

export async function updateLead(leadId: string, values: Partial<Pick<Lead, 'step'|'status'|'service'|'description'|'budget'|'deadline'|'phone'|'consent'>>): Promise<void> {
  const allowed = ['step','status','service','description','budget','deadline','phone','consent'] as const;
  const entries = allowed.filter((field) => values[field] !== undefined).map((field) => [field, values[field]] as const);
  if (!entries.length) return;
  const assignments = entries.map(([field], idx) => `${field}=$${idx + 2}`).join(',');
  await pool.query(`UPDATE leads SET ${assignments},updated_at=now() WHERE id=$1`, [leadId, ...entries.map(([, val]) => val)]);
}

export async function queueLead(leadId: string): Promise<void> {
  await pool.query(`UPDATE leads SET status='queued', step='done', consent=TRUE,updated_at=now() WHERE id=$1 AND status='collecting'`, [leadId]);
}

export async function resetLead(leadId: string, messageId: number, initialMessage: string): Promise<void> {
  await pool.query(
    `UPDATE leads SET first_message=$3,service=NULL,description=NULL,budget=NULL,deadline=NULL,phone=NULL,
     consent=FALSE,step='service',status='collecting',assigned_manager_id=NULL,tried_manager_ids='{}',
     notified_at=NULL,accepted_at=NULL,last_message_id=$2,updated_at=now() WHERE id=$1`,
    [leadId, messageId, initialMessage],
  );
}

export async function selectManager(excluded: string[]): Promise<Manager | null> {
  const { rows } = await pool.query<Manager>(
    `SELECT m.* FROM managers m
     WHERE m.is_active=TRUE AND NOT(m.telegram_id = ANY($1::bigint[]))
     ORDER BY (
       SELECT count(*) FROM leads l WHERE l.assigned_manager_id=m.telegram_id AND l.created_at >= date_trunc('day',now())
     ) ASC, m.telegram_id ASC LIMIT 1`,
    [excluded],
  );
  return rows[0] ?? null;
}

export async function claimLeadDispatch(leadId: string, managerId: string): Promise<Lead | null> {
  const { rows } = await pool.query<Lead>(
    `UPDATE leads SET status='dispatching',assigned_manager_id=$2,
     tried_manager_ids=array_append(tried_manager_ids,$2::bigint),updated_at=now()
     WHERE id=$1 AND status='queued' RETURNING *`,
    [leadId, managerId],
  );
  return rows[0] ?? null;
}

export async function pendingLeads(): Promise<Lead[]> {
  const { rows } = await pool.query<Lead>(`SELECT * FROM leads WHERE status='queued' ORDER BY id LIMIT 50`);
  return rows;
}

export async function setNotified(leadId: string): Promise<void> {
  await pool.query(`UPDATE leads SET status='notified',notified_at=now(),updated_at=now() WHERE id=$1 AND status='dispatching'`, [leadId]);
}

export async function dispatchFailed(leadId: string): Promise<void> {
  await pool.query(`UPDATE leads SET status='queued',assigned_manager_id=NULL,updated_at=now() WHERE id=$1 AND status='dispatching'`, [leadId]);
}

export async function setNeedsAttention(leadId: string): Promise<void> {
  await pool.query(`UPDATE leads SET status='needs_attention',assigned_manager_id=NULL,updated_at=now() WHERE id=$1 AND status='queued'`, [leadId]);
}

export async function getLead(leadId: string): Promise<Lead | null> {
  const { rows } = await pool.query<Lead>('SELECT * FROM leads WHERE id=$1', [leadId]);
  return rows[0] ?? null;
}

export async function acceptLead(leadId: string, managerId: string): Promise<Lead | null> {
  const { rows } = await pool.query<Lead>(
    `UPDATE leads SET status='accepted',accepted_at=now(),updated_at=now()
     WHERE id=$1 AND assigned_manager_id=$2 AND status='notified' RETURNING *`,
    [leadId, managerId],
  );
  return rows[0] ?? null;
}

export async function declineLead(leadId: string, managerId: string): Promise<Lead | null> {
  const { rows } = await pool.query<Lead>(
    `UPDATE leads SET status='queued',assigned_manager_id=NULL,notified_at=NULL,updated_at=now()
     WHERE id=$1 AND assigned_manager_id=$2 AND status='notified' RETURNING *`,
    [leadId, managerId],
  );
  return rows[0] ?? null;
}

export async function recycleExpired(): Promise<void> {
  await pool.query(
    `UPDATE leads SET status='queued',assigned_manager_id=NULL,notified_at=NULL,updated_at=now()
     WHERE status='notified' AND notified_at < now() - interval '30 minutes'`,
  );
  await pool.query(
    `UPDATE leads SET status='queued',assigned_manager_id=NULL,updated_at=now()
     WHERE status='dispatching' AND updated_at < now() - interval '5 minutes'`,
  );
}

export async function getManager(id: number): Promise<Manager | null> {
  const { rows } = await pool.query<Manager>('SELECT * FROM managers WHERE telegram_id=$1 AND is_active=TRUE', [id]);
  return rows[0] ?? null;
}
