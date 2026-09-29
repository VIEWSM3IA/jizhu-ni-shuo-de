const { randomUUID, randomBytes, createHash } = require('node:crypto');

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const graphemes = value => [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value)].length;
const clean = value => typeof value === 'string' ? value.trim() : '';
function aliasValue(value) {
  const alias = clean(value);
  if (!alias || graphemes(alias) > 12 || /[\u0000-\u001f\u007f]/u.test(alias)) fail(400, 'INVALID_ALIAS', '称呼需要 1–12 个字。');
  return alias;
}
function statementValue(value) {
  const statement = clean(value);
  if (graphemes(statement) < 2 || graphemes(statement) > 80 || /[\u0000-\u001f\u007f]/u.test(statement) || !/[\p{L}\p{N}]/u.test(statement)) fail(400, 'INVALID_STATEMENT', '这句话需要 2–80 个字，且不能只有表情。');
  return statement;
}
function opensValue(value, now) {
  const date = typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ? new Date(value) : new Date(NaN);
  const max = new Date(now); max.setUTCFullYear(max.getUTCFullYear() + 2);
  if (!Number.isFinite(date.getTime()) || date.getTime() < now.getTime() + 600000 || date > max) fail(400, 'INVALID_OPENS_AT', '开封时间须在 10 分钟后、2 年内。');
  return date;
}
const hash = token => createHash('sha256').update(token).digest('hex');
const iso = value => new Date(value).toISOString();

function createService(pool, { checkContent, now = () => new Date() }) {
  async function transaction(work) {
    const db = await pool.connect();
    try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async function login(openid) {
    if (!openid) fail(502, 'WECHAT_LOGIN_FAILED', '微信登录失败，请重试。');
    const user = (await pool.query(`INSERT INTO users(id,wechat_openid) VALUES($1,$2)
      ON CONFLICT(wechat_openid) DO UPDATE SET updated_at=now()
      RETURNING id,last_alias`, [randomUUID(), openid])).rows[0];
    const token = randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'30 days\')', [hash(token), user.id]);
    return { token, profile: { last_alias: user.last_alias } };
  }
  async function authenticate(token) {
    if (!token) fail(401, 'UNAUTHORIZED', '请重新登录。');
    const row = (await pool.query(`SELECT u.id,u.wechat_openid,u.last_alias FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash(token)])).rows[0];
    if (!row) fail(401, 'UNAUTHORIZED', '请重新登录。');
    return row;
  }
  async function detail(id, user, db = pool) {
    if (!uuid(id)) return { state: 'INVALID' };
    const c = (await db.query(`SELECT c.*, (SELECT count(*)::int FROM stances WHERE capsule_id=c.id) participant_count,
      s.stance my_stance FROM capsules c LEFT JOIN stances s ON s.capsule_id=c.id AND s.user_id=$2 WHERE c.id=$1`, [id, user.id])).rows[0];
    if (!c || c.status === 'cancelled') return { state: 'INVALID' };
    const participant = c.my_stance !== null;
    const state = c.status === 'opened' ? 'OPENED' : now() >= c.opens_at ? 'DUE' : participant ? 'SEALED' : 'JOINABLE';
    const dto = { id: c.id, statement: c.statement, creator_alias: c.creator_alias_snapshot,
      opens_at: iso(c.opens_at), created_at: iso(c.created_at), participant_count: c.participant_count, state,
      viewer: { is_creator: c.creator_user_id === user.id, is_participant: participant,
        my_stance: participant ? (c.my_stance ? 'agree' : 'disagree') : null } };
    const reminder = (await db.query('SELECT status FROM capsule_reminders WHERE capsule_id=$1 AND user_id=$2', [id, user.id])).rows[0];
    dto.viewer.reminder = {
      eligible: participant && state === 'SEALED' && now() < c.opens_at,
      state: reminder?.status === 'sent' ? 'sent' : ['pending', 'sending'].includes(reminder?.status) ? 'armed' : 'none'
    };
    if (state === 'OPENED' && participant) {
      dto.results = (await db.query(`SELECT s.id,s.alias_snapshot alias,s.stance,s.submitted_at,(s.user_id=c.creator_user_id) is_creator
        FROM stances s JOIN capsules c ON c.id=s.capsule_id WHERE s.capsule_id=$1
        ORDER BY is_creator DESC,s.submitted_at ASC,s.id ASC`, [id])).rows.map(r => ({
          id: r.id, alias: r.alias, stance: r.stance ? 'agree' : 'disagree', is_creator: r.is_creator, submitted_at: iso(r.submitted_at)
        }));
    }
    return dto;
  }
  async function create(user, body) {
    if (typeof body.client_request_id !== 'string' || !/^[A-Za-z0-9-]{16,100}$/.test(body.client_request_id)) fail(400, 'INVALID_REQUEST_ID', '请重试创建。');
    const samePayload = c => c.statement === clean(body.statement) && c.creator_alias_snapshot === clean(body.alias) &&
      typeof body.opens_at === 'string' && Date.parse(body.opens_at) === new Date(c.opens_at).getTime();
    const previous = (await pool.query('SELECT id,statement,creator_alias_snapshot,opens_at FROM capsules WHERE creator_user_id=$1 AND client_request_id=$2', [user.id, body.client_request_id])).rows[0];
    if (previous && !samePayload(previous)) fail(409, 'IDEMPOTENCY_CONFLICT', '内容已改变，请重新创建。');
    if (previous) return detail(previous.id, user);
    const statement = statementValue(body.statement), alias = aliasValue(body.alias), opensAt = opensValue(body.opens_at, now());
    await checkContent([statement, alias], user.wechat_openid);
    return transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${user.id}:${body.client_request_id}`]);
      const existing = (await db.query('SELECT id,statement,creator_alias_snapshot,opens_at FROM capsules WHERE creator_user_id=$1 AND client_request_id=$2', [user.id, body.client_request_id])).rows[0];
      if (existing && !samePayload(existing)) fail(409, 'IDEMPOTENCY_CONFLICT', '内容已改变，请重新创建。');
      if (existing) return detail(existing.id, user, db);
      const id = randomUUID();
      await db.query(`INSERT INTO capsules(id,creator_user_id,creator_alias_snapshot,statement,opens_at,client_request_id)
        VALUES($1,$2,$3,$4,$5,$6)`, [id, user.id, alias, statement, opensAt, body.client_request_id]);
      await db.query('INSERT INTO stances(id,capsule_id,user_id,alias_snapshot,stance) VALUES($1,$2,$3,$4,true)', [randomUUID(), id, user.id, alias]);
      await db.query('UPDATE users SET last_alias=$1,updated_at=now() WHERE id=$2', [alias, user.id]);
      return detail(id, user, db);
    });
  }
  async function stance(id, user, body) {
    if (!uuid(id)) fail(404, 'NOT_FOUND', '这句话已经不在了。');
    const prior = (await pool.query('SELECT 1 FROM stances WHERE capsule_id=$1 AND user_id=$2', [id, user.id])).rowCount;
    if (prior) return detail(id, user);
    if (!['agree', 'disagree'].includes(body.stance)) fail(400, 'INVALID_STANCE', '请选择同意或反对。');
    const alias = aliasValue(body.alias);
    await checkContent([alias], user.wechat_openid);
    return transaction(async db => {
      const c = (await db.query('SELECT * FROM capsules WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!c || c.status === 'cancelled') fail(404, 'NOT_FOUND', '这句话已经不在了。');
      const existing = (await db.query('SELECT 1 FROM stances WHERE capsule_id=$1 AND user_id=$2', [id, user.id])).rowCount;
      if (existing) return detail(id, user, db);
      if (c.status !== 'sealed' || now() >= c.opens_at) fail(409, 'NOT_JOINABLE', '押话已经截止。');
      await db.query('INSERT INTO stances(id,capsule_id,user_id,alias_snapshot,stance) VALUES($1,$2,$3,$4,$5)', [randomUUID(), id, user.id, alias, body.stance === 'agree']);
      await db.query('UPDATE users SET last_alias=$1,updated_at=now() WHERE id=$2', [alias, user.id]);
      return detail(id, user, db);
    });
  }
  async function open(id, user) {
    if (!uuid(id)) fail(404, 'NOT_FOUND', '这句话已经不在了。');
    return transaction(async db => {
      const c = (await db.query('SELECT * FROM capsules WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!c || c.status === 'cancelled') fail(404, 'NOT_FOUND', '这句话已经不在了。');
      const participant = (await db.query('SELECT 1 FROM stances WHERE capsule_id=$1 AND user_id=$2', [id, user.id])).rowCount;
      if (!participant) fail(403, 'PARTICIPANT_ONLY', '结果只对参与者开放。');
      if (c.status === 'sealed') {
        if (now() < c.opens_at) fail(409, 'NOT_DUE', '还没到开封时间。');
        await db.query(`UPDATE capsules SET status='opened',opened_at=$2,opened_by_user_id=$3 WHERE id=$1 AND status='sealed'`, [id, now(), user.id]);
      }
      return detail(id, user, db);
    });
  }
  async function cancel(id, user) {
    if (!uuid(id)) fail(404, 'NOT_FOUND', '这句话已经不在了。');
    return transaction(async db => {
      const c = (await db.query('SELECT * FROM capsules WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!c || c.status === 'cancelled') fail(404, 'NOT_FOUND', '这句话已经不在了。');
      if (c.creator_user_id !== user.id) fail(403, 'CREATOR_ONLY', '只有发起人可以撤销。');
      const count = (await db.query('SELECT count(*)::int count FROM stances WHERE capsule_id=$1', [id])).rows[0].count;
      if (c.status !== 'sealed' || now() >= c.opens_at || count !== 1) fail(409, 'CANNOT_CANCEL', '这句话已到期或已有朋友参与，不能撤销。');
      await db.query("UPDATE capsules SET status='cancelled',cancelled_at=now() WHERE id=$1", [id]);
      await db.query(`UPDATE capsule_reminders SET status='cancelled',cancelled_at=now(),lease_token=NULL,lease_until=NULL,updated_at=now()
        WHERE capsule_id=$1 AND status IN ('pending','sending')`, [id]);
      return { state: 'INVALID' };
    });
  }
  async function armReminder(id, user, body) {
    const templateId = process.env.WECHAT_REMINDER_TEMPLATE_ID;
    if (!templateId) fail(503, 'REMINDER_UNAVAILABLE', '提醒服务暂不可用');
    if (!uuid(id)) fail(404, 'CAPSULE_NOT_FOUND', '胶囊不存在');
    const timezone = body?.timezone_offset_minutes;
    if (!Number.isInteger(timezone) || timezone < -720 || timezone > 840) fail(400, 'INVALID_TIMEZONE', '时区偏移无效');
    if (body?.template_id !== templateId) fail(400, 'REMINDER_TEMPLATE_MISMATCH', '提醒模板不匹配');
    return transaction(async db => {
      const capsule = (await db.query('SELECT id,status,opens_at FROM capsules WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!capsule) fail(404, 'CAPSULE_NOT_FOUND', '胶囊不存在');
      const current = now(), opensAt = new Date(capsule.opens_at);
      if (!(await db.query('SELECT 1 FROM stances WHERE capsule_id=$1 AND user_id=$2', [id, user.id])).rowCount) fail(409, 'REMINDER_NOT_ELIGIBLE', '参与后才能设置提醒');
      const reminder = (await db.query('SELECT status FROM capsule_reminders WHERE capsule_id=$1 AND user_id=$2 FOR UPDATE', [id, user.id])).rows[0];
      if (reminder?.status === 'sent') fail(409, 'REMINDER_ALREADY_SENT', '提醒已发送');
      if (reminder?.status === 'pending' || reminder?.status === 'sending') return { state: 'armed' };
      if (capsule.status !== 'sealed' || current >= opensAt) fail(409, 'REMINDER_NOT_ELIGIBLE', '当前胶囊不可设置提醒');
      const expiresAt = new Date(opensAt.getTime() + 24 * 60 * 60 * 1000);
      if (reminder) {
        await db.query(`UPDATE capsule_reminders SET template_id=$3,status='pending',send_after=$4,expires_at=$5,
          timezone_offset_minutes=$6,attempt_count=0,next_attempt_at=$4,lease_token=NULL,lease_until=NULL,
          sent_at=NULL,cancelled_at=NULL,failed_at=NULL,last_error_code=NULL,updated_at=$7
          WHERE capsule_id=$1 AND user_id=$2`, [id, user.id, templateId, opensAt, expiresAt, timezone, current]);
      } else {
        await db.query(`INSERT INTO capsule_reminders
          (id,capsule_id,user_id,template_id,status,send_after,expires_at,timezone_offset_minutes,attempt_count,next_attempt_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,'pending',$5,$6,$7,0,$5,$8,$8)`, [randomUUID(), id, user.id, templateId, opensAt, expiresAt, timezone, current]);
      }
      return { state: 'armed' };
    });
  }
  async function cancelReminder(id, user) {
    if (!uuid(id)) fail(404, 'CAPSULE_NOT_FOUND', '胶囊不存在');
    return transaction(async db => {
      const capsule = (await db.query('SELECT id FROM capsules WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!capsule) fail(404, 'CAPSULE_NOT_FOUND', '胶囊不存在');
      if (!(await db.query('SELECT 1 FROM stances WHERE capsule_id=$1 AND user_id=$2', [id, user.id])).rowCount) fail(403, 'REMINDER_FORBIDDEN', '仅参与者可操作提醒');
      const reminder = (await db.query('SELECT status FROM capsule_reminders WHERE capsule_id=$1 AND user_id=$2 FOR UPDATE', [id, user.id])).rows[0];
      if (!reminder || ['cancelled', 'failed', 'expired'].includes(reminder.status)) return { state: 'none' };
      if (reminder.status === 'sent') fail(409, 'REMINDER_ALREADY_SENT', '提醒已发送');
      await db.query(`UPDATE capsule_reminders SET status='cancelled',cancelled_at=$3,lease_token=NULL,lease_until=NULL,updated_at=$3
        WHERE capsule_id=$1 AND user_id=$2 AND status IN ('pending','sending')`, [id, user.id, now()]);
      return { state: 'none' };
    });
  }
  async function report(id, user) {
    if (!uuid(id)) fail(404, 'NOT_FOUND', '这句话已经不在了。');
    const c = (await pool.query("SELECT 1 FROM capsules WHERE id=$1 AND status<>'cancelled'", [id])).rowCount;
    if (!c) fail(404, 'NOT_FOUND', '这句话已经不在了。');
    await pool.query('INSERT INTO reports(id,capsule_id,reporter_user_id) VALUES($1,$2,$3) ON CONFLICT(capsule_id,reporter_user_id) DO NOTHING', [randomUUID(), id, user.id]);
    return { ok: true };
  }
  async function list(user, { state, cursor } = {}) {
    if (cursor && !uuid(cursor)) fail(400, 'INVALID_CURSOR', '列表位置无效。');
    // ponytail: personal lists are small; move sorting/cursors into SQL if accounts grow past a few hundred capsules.
    const rows = (await pool.query(`SELECT c.id,c.statement,c.opens_at,c.opened_at,c.created_at,c.status,c.creator_user_id,
      (SELECT count(*)::int FROM stances WHERE capsule_id=c.id) participant_count
      FROM capsules c JOIN stances mine ON mine.capsule_id=c.id AND mine.user_id=$1
      WHERE c.status<>'cancelled'`, [user.id])).rows.map(c => ({
        id: c.id, statement: c.statement, opens_at: iso(c.opens_at), participant_count: c.participant_count,
        role: c.creator_user_id === user.id ? 'creator' : 'participant',
        state: c.status === 'opened' ? 'OPENED' : now() >= c.opens_at ? 'DUE' : 'SEALED',
        sort_time: c.status === 'opened' ? new Date(c.opened_at).getTime() : new Date(c.opens_at).getTime()
      }));
    const rank = { DUE: 0, SEALED: 1, OPENED: 2 };
    rows.sort((a,b) => rank[a.state]-rank[b.state] || (a.state === 'OPENED' ? b.sort_time-a.sort_time : a.sort_time-b.sort_time) || a.id.localeCompare(b.id));
    const listNow = now(), upcomingCutoff = new Date(listNow.getTime() + 86400000);
    const summary = { due_count: 0, upcoming_24h_count: 0 };
    for (const item of rows) {
      if (item.state === 'DUE') summary.due_count++;
      item.upcoming_24h = item.state === 'SEALED' && new Date(item.opens_at) > listNow && new Date(item.opens_at) <= upcomingCutoff;
      if (item.upcoming_24h) summary.upcoming_24h_count++;
    }
    const filtered = rows.filter(c => !state || state === 'ALL' || (state === 'ACTIVE' ? c.state === 'SEALED' : c.state === state));
    const start = cursor ? filtered.findIndex(c => c.id === cursor) + 1 : 0;
    if (cursor && start === 0) fail(400, 'INVALID_CURSOR', '列表位置无效。');
    const page = filtered.slice(start, start + 20);
    return { items: page.map(({sort_time,...item}) => item), next_cursor: filtered.length > start+20 ? page.at(-1).id : null, summary };
  }
  const allowedEvents = new Set(['home_view','create_sheet_open','create_submit','create_success','share_intent','capsule_view','stance_tap','alias_sheet_view','alias_submit','stance_success','due_view','open_tap','open_success','opened_view','opened_share_intent','capsule_cancel','reminder_cta_view','reminder_cta_tap','reminder_permission_result','reminder_arm_success','reminder_arm_retry','reminder_cancel','reminder_entry_view']);
  const analyticsPropertyValues = {
    viewer_role: new Set(['creator','participant','visitor']),
    capsule_state: new Set(['JOINABLE','SEALED','DUE','OPENED','INVALID']),
    entry_source: new Set(['share','home','direct','reminder']),
    permission_result: new Set(['accept','acceptWithAudio','reject','ban','filter','error']),
    reminder_state: new Set(['none','armed','sent'])
  };
  async function event(user, body) {
    if (!allowedEvents.has(body.name)) fail(400, 'INVALID_EVENT', '事件无效。');
    const props = {};
    for (const [key, values] of Object.entries(analyticsPropertyValues)) {
      if (typeof body[key] === 'string' && values.has(body[key])) props[key] = body[key];
    }
    await pool.query('INSERT INTO analytics_events(user_id,capsule_id,name,properties) VALUES($1,$2,$3,$4)', [user.id, uuid(body.capsule_id) ? body.capsule_id : null, body.name, props]);
    return { ok: true };
  }
  return { login, authenticate, detail, create, stance, open, cancel, armReminder, cancelReminder, report, list, event };
}
module.exports = { createService, ApiError, aliasValue, statementValue, opensValue };
