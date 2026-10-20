import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Step = 'purpose' | 'city' | 'width' | 'length' | 'wall_height' | 'insulation' | 'contact_name' | 'phone' | 'review' | 'edit' | 'done';
export type LeadStatus = 'collecting' | 'queued' | 'dispatching' | 'notified' | 'accepted' | 'cancelled' | 'needs_attention';

export interface Lead {
  id: string;
  purpose: string | null;
  city: string | null;
  width: string | null;
  length: string | null;
  wall_height: string | null;
  insulation: string | null;
  contact_name: string | null;
  revision: number;
  resume_step: Step | null;
  text_choices: boolean;
  prompt_message_id: number | null;
  prompt_has_reply_keyboard: boolean;
  business_connection_id: string;
  client_chat_id: string;
  client_telegram_id: string;
  client_name: string;
  client_username: string | null;
  first_message: string | null;
  request_code: string | null;
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

// Every answer, edit and submission consumes a revision atomically. Old callbacks
// and concurrent updates cannot overwrite a newer answer or queue a lead twice.
export async function saveAnswer(lead: Lead, values: import('./qualification.js').Changes, messageId?: number): Promise<Lead | null> {
  const allowed = ['purpose','city','width','length','wall_height','insulation','contact_name','phone','step','status','consent','resume_step'] as const;
  const entries = allowed.filter(field => values[field] !== undefined).map(field => [field, values[field]] as const);
  const params: unknown[] = [lead.id, lead.revision, ...entries.map(([,value]) => value)];
  const assignments = entries.map(([field], i) => `${field}=$${i+3}`);
  if (messageId !== undefined) {
    params.push(messageId);
    assignments.push(`last_message_id=$${params.length}`);
  }
  const { rows } = await pool.query<Lead>(`UPDATE leads SET ${assignments.join(',')}, revision=revision+1,updated_at=now()
    WHERE id=$1 AND revision=$2 AND status='collecting' ${messageId === undefined ? '' : `AND last_message_id < $${params.length}`} RETURNING *`,params);
  return rows[0] ?? null;
}

export async function resetLead(lead: Lead, messageId: number): Promise<Lead | null> {
  const { rows } = await pool.query<Lead>(`UPDATE leads SET purpose=NULL,city=NULL,width=NULL,length=NULL,wall_height=NULL,
    insulation=NULL,contact_name=NULL,deadline=NULL,phone=NULL,consent=FALSE,step='purpose',resume_step=NULL,
    status='collecting',assigned_manager_id=NULL,tried_manager_ids='{}',notified_at=NULL,accepted_at=NULL,
    last_message_id=$3,revision=revision+1,updated_at=now()
    WHERE id=$1 AND revision=$2 AND status IN ('cancelled','needs_attention') AND last_message_id < $3 RETURNING *`,[lead.id,lead.revision,messageId]);
  return rows[0] ?? null;
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

export interface EntryInput {
  connectionId: string;
  chatId: number;
  userId: number;
  name: string;
  username?: string;
  text: string;
  messageId: number;
}
export interface ConversationEntry {
  business_connection_id: string;
  chat_id: string;
  user_id: string;
  client_name: string;
  username: string | null;
  message_id: string;
  message_text: string;
  request_code: string | null;
}

export async function recordEntry(data: EntryInput, code: string | null): Promise<void> {
  await pool.query(`INSERT INTO conversation_entries
    (business_connection_id,chat_id,user_id,client_name,username,message_id,message_text,request_code,start_after)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8::text IS NULL THEN NULL ELSE now()+interval '3 minutes' END)
    ON CONFLICT (business_connection_id,chat_id) DO UPDATE SET
      user_id=EXCLUDED.user_id,client_name=EXCLUDED.client_name,username=EXCLUDED.username,
      message_id=EXCLUDED.message_id,message_text=EXCLUDED.message_text,
      request_code=EXCLUDED.request_code,start_after=EXCLUDED.start_after,received_at=now()
    WHERE conversation_entries.message_id < EXCLUDED.message_id`,
    [data.connectionId,data.chatId,data.userId,data.name,data.username ?? null,data.messageId,data.text,code]);
}

export async function dueEntries(): Promise<ConversationEntry[]> {
  // Do not send a delayed greeting from an old restored backup, outside the
  // Business reply window. Retain a deduplication tombstone instead.
  await pool.query(`UPDATE conversation_entries SET start_after=NULL WHERE received_at < now()-interval '23 hours' AND start_after IS NOT NULL`);
  const {rows} = await pool.query<ConversationEntry>(`SELECT * FROM conversation_entries WHERE start_after <= now() ORDER BY start_after LIMIT 50`);
  return rows;
}

export async function activateEntry(entry: ConversationEntry): Promise<Lead | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(`UPDATE conversation_entries SET start_after=now()+interval '1 minute'
      WHERE business_connection_id=$1 AND chat_id=$2 AND message_id=$3 AND start_after <= now()
      RETURNING *`,[entry.business_connection_id,entry.chat_id,entry.message_id]);
    if (!claimed.rowCount) { await client.query('ROLLBACK'); return null; }
    const {rows} = await client.query<Lead>(`INSERT INTO leads
      (business_connection_id,client_chat_id,client_telegram_id,client_name,client_username,first_message,last_message_id,request_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (business_connection_id,client_chat_id) DO NOTHING RETURNING *`,
      [entry.business_connection_id,entry.chat_id,entry.user_id,entry.client_name,entry.username,entry.message_text,entry.message_id,entry.request_code]);
    const retry = rows[0] ? undefined : (await client.query<Lead>(`SELECT * FROM leads WHERE business_connection_id=$1 AND client_chat_id=$2
      AND status='collecting' AND revision=0 AND prompt_message_id IS NULL`,[entry.business_connection_id,entry.chat_id])).rows[0];
    if (!rows[0] && !retry) await client.query('UPDATE conversation_entries SET start_after=NULL WHERE business_connection_id=$1 AND chat_id=$2',[entry.business_connection_id,entry.chat_id]);
    await client.query('COMMIT');
    return rows[0] ?? retry ?? null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function retryEntry(entry: ConversationEntry, leadId: string): Promise<void> {
  await pool.query(`UPDATE conversation_entries SET start_after=now()+interval '5 seconds'
    WHERE business_connection_id=$1 AND chat_id=$2 AND message_id=$3
    AND EXISTS (SELECT 1 FROM leads WHERE id=$4 AND status='collecting' AND revision=0 AND prompt_message_id IS NULL)`,
    [entry.business_connection_id,entry.chat_id,entry.message_id,leadId]);
}

export async function finishEntry(entry: ConversationEntry): Promise<void> {
  await pool.query(`UPDATE conversation_entries SET start_after=NULL WHERE business_connection_id=$1 AND chat_id=$2 AND message_id=$3`,
    [entry.business_connection_id,entry.chat_id,entry.message_id]);
}
