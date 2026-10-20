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
