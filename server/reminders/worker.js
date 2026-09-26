'use strict';

const { randomUUID } = require('crypto');

function createReminderWorker(pool, { send, now = () => new Date(), logger = console }) {
  if (!pool || typeof send !== 'function') throw new TypeError('pool and send required');

  async function emitSendResult(row, result) {
    try {
      await pool.query(`INSERT INTO analytics_events(user_id,capsule_id,name,properties)
        VALUES($1,$2,'reminder_send_result',$3::jsonb)`,
        [row.user_id, row.capsule_id, JSON.stringify({ send_result: result })]);
    } catch { logger.warn?.('reminder analytics insert failed', { capsule_id: row.capsule_id }); }
  }

  async function tick() {
    const ts = now();

    const recovered = await pool.query(
      `UPDATE capsule_reminders
       SET status=CASE
             WHEN expires_at <= $1 THEN 'expired'
             WHEN attempt_count >= 3 THEN 'failed'
             ELSE 'pending'
           END,
           next_attempt_at=CASE
             WHEN expires_at > $1 AND attempt_count < 3 THEN $1
             ELSE next_attempt_at
           END,
           failed_at=CASE WHEN expires_at > $1 AND attempt_count >= 3 THEN $1 ELSE failed_at END,
           lease_token=NULL, lease_until=NULL, updated_at=$1
       WHERE status='sending' AND lease_until <= $1
       RETURNING user_id,capsule_id,status`,
      [ts]
    );
    for (const row of recovered.rows) await emitSendResult(row, row.status === 'pending' ? 'retry' : row.status === 'failed' ? 'terminal_fail' : 'expired');

    const expired = await pool.query(
      `UPDATE capsule_reminders
       SET status='expired', lease_token=NULL, lease_until=NULL, updated_at=$1
       WHERE status='pending' AND expires_at <= $1
       RETURNING user_id,capsule_id`,
      [ts]
    );
    for (const row of expired.rows) await emitSendResult(row, 'expired');

    const claimAt = now();
    const client = await pool.connect();
    let job;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT r.id,r.user_id,r.capsule_id,r.template_id,r.send_after,r.expires_at,
                r.timezone_offset_minutes,r.attempt_count,u.wechat_openid
         FROM capsule_reminders r
         JOIN users u ON u.id=r.user_id
         JOIN capsules c ON c.id=r.capsule_id
         WHERE r.status='pending'
           AND c.status<>'cancelled'
           AND r.send_after <= $1
           AND COALESCE(r.next_attempt_at,r.send_after) <= $1
           AND r.expires_at > $1
         ORDER BY COALESCE(r.next_attempt_at,r.send_after),r.id
         FOR UPDATE OF r SKIP LOCKED
         LIMIT 1`,
        [claimAt]
      );
      if (!rows[0]) {
        await client.query('COMMIT');
        return null;
      }

      const row = rows[0];
      const token = randomUUID();
      const leaseUntil = new Date(claimAt.getTime() + 2 * 60 * 1000);
      const claimed = await client.query(
        `UPDATE capsule_reminders
         SET status='sending',lease_token=$2,lease_until=$3,
             attempt_count=attempt_count+1,updated_at=$4
         WHERE id=$1 AND status='pending'
         RETURNING attempt_count`,
        [row.id, token, leaseUntil, claimAt]
      );
      job = { ...row, leaseToken: token, attemptCount: claimed.rows[0].attempt_count };
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // A cancellation committed after claim must be observed before the provider call.
    const stillActive = await pool.query(`SELECT 1 FROM capsule_reminders r JOIN capsules c ON c.id=r.capsule_id
      WHERE r.id=$1 AND r.status='sending' AND r.lease_token=$2 AND r.lease_until>$3
        AND r.expires_at>$3 AND c.status<>'cancelled'`, [job.id, job.leaseToken, now()]);
    if (!stillActive.rowCount) return 'stale';

    let sendError = null;
    try {
      await send({
        openid: job.wechat_openid,
        templateId: job.template_id,
        capsuleId: job.capsule_id,
        opensAt: job.send_after,
        timezoneOffsetMinutes: job.timezone_offset_minutes
      });
    } catch (error) { sendError = error; }

    if (!sendError) {
      const done = await pool.query(
        `UPDATE capsule_reminders
         SET status='sent',sent_at=$3,lease_token=NULL,lease_until=NULL,
             last_error_code=NULL,updated_at=$3
         WHERE id=$1 AND status='sending' AND lease_token=$2
         RETURNING user_id,capsule_id`,
        [job.id, job.leaseToken, now()]
      );
      if (done.rowCount) await emitSendResult(done.rows[0], 'success');
      logger.info?.('reminder send result', { id: job.id, result: done.rowCount ? 'sent' : 'stale' });
      return done.rowCount ? 'sent' : 'stale';
    } else {
      const ts2 = now();
      const terminal = sendError.terminal === true;
      const code = String(sendError.code || sendError.name || 'send_error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);
      let status = 'failed';
      let next = null;

      if (!terminal && job.attemptCount < 3 && ts2 < job.expires_at) {
        const delays = [60_000, 300_000, 1_200_000];
        next = new Date(Math.min(
          ts2.getTime() + delays[Math.max(0, job.attemptCount - 1)],
          job.expires_at.getTime()
        ));
        status = next > ts2 ? 'pending' : 'expired';
      } else if (ts2 >= job.expires_at) {
        status = 'expired';
      }

      const done = await pool.query(
        `UPDATE capsule_reminders
         SET status=$3,next_attempt_at=$4,
             failed_at=CASE WHEN $3='failed' THEN $5 ELSE failed_at END,
             last_error_code=$6,lease_token=NULL,lease_until=NULL,updated_at=$5
         WHERE id=$1 AND status='sending' AND lease_token=$2
         RETURNING user_id,capsule_id,status`,
        [job.id, job.leaseToken, status, next, ts2, code]
      );
      if (done.rowCount) await emitSendResult(done.rows[0], status === 'pending' ? 'retry' : status === 'failed' ? 'terminal_fail' : 'expired');
      logger.warn?.('reminder send result', {
        id: job.id,
        result: done.rowCount ? status : 'stale',
        code
      });
      return done.rowCount ? status : 'stale';
    }

  }

  function start(pollMs) {
    const timer = setInterval(() => {
      tick().catch(err => logger.error?.('reminder worker tick failed', {
        error: String(err?.code || err?.name || 'error')
      }));
    }, pollMs);
    return () => clearInterval(timer);
  }

  return { tick, start };
}

module.exports = { createReminderWorker };
