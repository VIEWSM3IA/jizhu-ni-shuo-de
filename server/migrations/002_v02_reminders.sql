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
