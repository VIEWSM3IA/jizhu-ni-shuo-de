CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  wechat_openid text UNIQUE NOT NULL,
  last_alias text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS capsules (
  id uuid PRIMARY KEY,
  creator_user_id uuid NOT NULL REFERENCES users(id),
  creator_alias_snapshot text NOT NULL,
  statement text NOT NULL,
  opens_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'sealed' CHECK (status IN ('sealed','opened','cancelled')),
  opened_at timestamptz,
  opened_by_user_id uuid REFERENCES users(id),
  cancelled_at timestamptz,
  client_request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_user_id, client_request_id)
);
CREATE TABLE IF NOT EXISTS stances (
  id uuid PRIMARY KEY,
  capsule_id uuid NOT NULL REFERENCES capsules(id),
  user_id uuid NOT NULL REFERENCES users(id),
  alias_snapshot text NOT NULL,
  stance boolean NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capsule_id, user_id)
);
CREATE INDEX IF NOT EXISTS stances_user_idx ON stances(user_id, submitted_at DESC);
CREATE TABLE IF NOT EXISTS analytics_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  capsule_id uuid,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY,
  capsule_id uuid NOT NULL REFERENCES capsules(id),
  reporter_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(capsule_id,reporter_user_id)
);

CREATE TABLE IF NOT EXISTS capsule_reminders (
  id uuid PRIMARY KEY,
  capsule_id uuid NOT NULL REFERENCES capsules(id),
  user_id uuid NOT NULL REFERENCES users(id),
  template_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','sending','sent','cancelled','failed','expired')),
  send_after timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  timezone_offset_minutes smallint NOT NULL DEFAULT 480 CHECK (timezone_offset_minutes BETWEEN -720 AND 840),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capsule_id, user_id),
  CHECK (expires_at > send_after),
  CHECK (status <> 'sending' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS capsule_reminders_due_idx
  ON capsule_reminders (COALESCE(next_attempt_at, send_after)) WHERE status='pending';
CREATE INDEX IF NOT EXISTS capsule_reminders_lease_idx
  ON capsule_reminders (lease_until) WHERE status='sending';
