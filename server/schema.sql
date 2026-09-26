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
