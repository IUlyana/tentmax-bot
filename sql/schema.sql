CREATE TABLE IF NOT EXISTS managers (
  telegram_id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  business_connection_id TEXT NOT NULL,
  client_chat_id BIGINT NOT NULL,
  client_telegram_id BIGINT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  client_username TEXT,
  first_message TEXT,
  service TEXT,
  description TEXT,
  budget TEXT,
  deadline TEXT,
  phone TEXT,
  consent BOOLEAN NOT NULL DEFAULT FALSE,
  step TEXT NOT NULL DEFAULT 'service',
  status TEXT NOT NULL DEFAULT 'collecting',
  assigned_manager_id BIGINT REFERENCES managers(telegram_id),
  tried_manager_ids BIGINT[] NOT NULL DEFAULT '{}',
  last_message_id BIGINT NOT NULL DEFAULT 0,
  notified_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_connection_id, client_chat_id),
  CONSTRAINT valid_lead_status CHECK (status IN ('collecting','queued','dispatching','notified','accepted','cancelled','needs_attention')),
  CONSTRAINT valid_lead_step CHECK (step IN ('service','description','budget','deadline','phone','consent','done'))
);

CREATE INDEX IF NOT EXISTS leads_delivery_idx ON leads(status, created_at);
CREATE INDEX IF NOT EXISTS leads_manager_idx ON leads(assigned_manager_id, created_at);

-- Additive migration: preserve historical lead and dispatch data.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS purpose TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS width NUMERIC;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS length NUMERIC;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS wall_height NUMERIC;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS insulation TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS resume_step TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS prompt_message_id INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS prompt_has_reply_keyboard BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS text_choices BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS form_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leads ALTER COLUMN form_version SET DEFAULT 2;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS valid_lead_step;
UPDATE leads SET step=CASE WHEN status='collecting' THEN 'purpose' ELSE 'done' END,
  consent=CASE WHEN status='collecting' THEN FALSE ELSE consent END, revision=revision+1,form_version=2
  WHERE form_version=1;
-- Continue questionnaires paused at the retired installation-date question.
UPDATE leads SET
  step=CASE WHEN step='deadline' THEN 'contact_name' ELSE step END,
  resume_step=CASE WHEN resume_step='deadline' THEN 'contact_name' ELSE resume_step END,
  revision=revision+1
  WHERE step='deadline' OR resume_step='deadline';
ALTER TABLE leads ALTER COLUMN step SET DEFAULT 'purpose';
ALTER TABLE leads ADD CONSTRAINT valid_lead_step CHECK (step IN
  ('purpose','city','width','length','wall_height','insulation','contact_name','phone','review','edit','done'));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='leads'::regclass AND conname='positive_dimensions') THEN
    ALTER TABLE leads ADD CONSTRAINT positive_dimensions CHECK
      ((width IS NULL OR width > 0) AND (length IS NULL OR length > 0) AND (wall_height IS NULL OR wall_height > 0));
  END IF;
END $$;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS request_code TEXT;
-- Keep cancelled entries as deduplication records so Telegram redelivery cannot
-- re-arm a timer. The database clock drives the delay across bot restarts.
CREATE TABLE IF NOT EXISTS conversation_entries (
  business_connection_id TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  client_name TEXT NOT NULL,
  username TEXT,
  message_id BIGINT NOT NULL,
  message_text TEXT NOT NULL,
  request_code TEXT,
  start_after TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_connection_id, chat_id)
);
CREATE INDEX IF NOT EXISTS conversation_entries_due_idx ON conversation_entries(start_after) WHERE start_after IS NOT NULL;
