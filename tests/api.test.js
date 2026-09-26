const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { Pool } = require('pg');
const { createHandler } = require('../server/index');
const { createService, ApiError } = require('../server/service');

let pool, server, base, clock, service;
const tokens = {};
const request = async (path, method = 'GET', body, token) => {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
};
const createBody = (requestId, statement = '明天会下雨') => ({
  statement, alias: '阿杰', opens_at: new Date(clock.getTime() + 3600000).toISOString(), client_request_id: requestId
});

before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database');
  if (!/test/i.test(new URL(process.env.TEST_DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL must name a test database');
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(fs.readFileSync('server/schema.sql', 'utf8'));
  await pool.query('TRUNCATE reports,analytics_events,stances,capsules,sessions,users RESTART IDENTITY CASCADE');
  clock = new Date('2026-09-26T10:00:00.000Z');
  service = createService(pool, { now: () => clock, checkContent: async values => {
    if (values.some(value => value.includes('违规'))) throw new ApiError(422, 'CONTENT_REJECTED', '内容不合适');
  } });
  server = http.createServer(createHandler(service, async code => code));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const user of ['creator', 'friend', 'visitor']) {
    const result = await request('/v1/auth/wechat', 'POST', { code: user });
    assert.equal(result.status, 200);
    tokens[user] = result.data.token;
  }
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); if (pool) await pool.end(); });

test('create validates fields, checks content, and is atomic and retry safe', async () => {
  const invalid = [
    { statement: '' }, { statement: '字' }, { statement: '😀😀' }, { statement: '字'.repeat(81) },
    { alias: '' }, { alias: '字'.repeat(13) },
    { opens_at: new Date(clock.getTime()+9*60000).toISOString() },
    { opens_at: new Date('2029-01-01').toISOString() }
  ];
  for (const [i, patch] of invalid.entries()) {
    const response = await request('/v1/capsules', 'POST', { ...createBody(`invalid-request-${i}`), ...patch }, tokens.creator);
    assert.equal(response.status, 400);
  }
  const rejected = await request('/v1/capsules', 'POST', createBody('rejected-request-1', '违规内容'), tokens.creator);
  assert.equal(rejected.data.error.code, 'CONTENT_REJECTED');
  assert.equal((await pool.query('SELECT count(*)::int n FROM capsules')).rows[0].n, 0);
  for (const [requestId, statement, alias, minutes] of [
    ['min-length-request-12345', '中文', 'A', 10],
    ['max-length-request-12345', '字'.repeat(80), '十二字以内', 60]
  ]) {
    const valid = await request('/v1/capsules', 'POST', { ...createBody(requestId, statement), alias, opens_at: new Date(clock.getTime()+minutes*60000).toISOString() }, tokens.creator);
    assert.equal(valid.status, 201);
    assert.equal((await request(`/v1/capsules/${valid.data.id}`, 'DELETE', {}, tokens.creator)).status, 200);
  }
  const body = createBody('same-create-request-12345');
  const [a,b] = await Promise.all(Array.from({length:2}, () => request('/v1/capsules', 'POST', body, tokens.creator)));
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.equal(a.data.id, b.data.id);
  assert.equal(a.data.state, 'SEALED');
  assert.equal(a.data.viewer.my_stance, 'agree');
  assert.equal((await pool.query('SELECT count(*)::int n FROM stances WHERE capsule_id=$1', [a.data.id])).rows[0].n, 1);
  const retry = await request('/v1/capsules', 'POST', body, tokens.creator);
  assert.equal(retry.data.id, a.data.id);
  const changedRetry = await request('/v1/capsules', 'POST', { ...body, statement: '已经改了内容' }, tokens.creator);
  assert.equal(changedRetry.status, 409);
  assert.equal(changedRetry.data.error.code, 'IDEMPOTENCY_CONFLICT');
  clock = new Date(clock.getTime() + 2*3600000);
  assert.equal((await request('/v1/capsules', 'POST', body, tokens.creator)).data.id, a.data.id);
  clock = new Date(clock.getTime() - 2*3600000);
  global.capsuleId = a.data.id;
});

test('private stance, duplicate submissions, cutoff and cancellation rules', async () => {
  const id = global.capsuleId;
  const visitorBefore = await request(`/v1/capsules/${id}`, 'GET', undefined, tokens.visitor);
  assert.equal(visitorBefore.data.state, 'JOINABLE');
  assert.equal(visitorBefore.data.results, undefined);
  assert.equal(visitorBefore.data.viewer.my_stance, null);
  const [a,b] = await Promise.all([
    request(`/v1/capsules/${id}/stances`, 'POST', { stance: 'disagree', alias: '小明' }, tokens.friend),
    request(`/v1/capsules/${id}/stances`, 'POST', { stance: 'agree', alias: '改名' }, tokens.friend)
  ]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.data.viewer.my_stance, b.data.viewer.my_stance);
  assert.equal((await pool.query('SELECT count(*)::int n FROM stances WHERE capsule_id=$1', [id])).rows[0].n, 2);
  const creator = await request(`/v1/capsules/${id}`, 'GET', undefined, tokens.creator);
  assert.equal(creator.data.state, 'SEALED');
  assert.equal(creator.data.results, undefined);
  assert.ok(!JSON.stringify(creator.data).includes('小明'));
  assert.ok(!JSON.stringify(creator.data).includes('openid'));
  const cannotCancel = await request(`/v1/capsules/${id}`, 'DELETE', {}, tokens.creator);
  assert.equal(cannotCancel.data.error.code, 'CANNOT_CANCEL');
  const earlyOpen = await request(`/v1/capsules/${id}/open`, 'POST', {}, tokens.creator);
  assert.equal(earlyOpen.data.error.code, 'NOT_DUE');
  clock = new Date(clock.getTime() + 3600000);
  const late = await request(`/v1/capsules/${id}/stances`, 'POST', { stance: 'agree', alias: '访客' }, tokens.visitor);
  assert.equal(late.data.error.code, 'NOT_JOINABLE');
  const due = await request(`/v1/capsules/${id}`, 'GET', undefined, tokens.visitor);
  assert.equal(due.data.state, 'DUE'); assert.equal(due.data.results, undefined);
  const visitorOpen = await request(`/v1/capsules/${id}/open`, 'POST', {}, tokens.visitor);
  assert.equal(visitorOpen.data.error.code, 'PARTICIPANT_ONLY');
});

test('concurrent open returns the same participant-only result and home updates', async () => {
  const id = global.capsuleId;
  const [a,b] = await Promise.all([
    request(`/v1/capsules/${id}/open`, 'POST', {}, tokens.creator),
    request(`/v1/capsules/${id}/open`, 'POST', {}, tokens.friend)
  ]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.deepEqual(a.data.results, b.data.results);
  assert.equal(a.data.results.length, 2);
  assert.equal(a.data.results[0].is_creator, true);
  assert.ok(a.data.results.every(result => /^[0-9a-f-]{36}$/.test(result.id)));
  assert.equal(new Set(a.data.results.map(result => result.id)).size, a.data.results.length);
  assert.equal((await pool.query('SELECT count(*)::int n FROM capsules WHERE id=$1 AND opened_by_user_id IS NOT NULL', [id])).rows[0].n, 1);
  const visitor = await request(`/v1/capsules/${id}`, 'GET', undefined, tokens.visitor);
  assert.equal(visitor.data.state, 'OPENED'); assert.equal(visitor.data.results, undefined);
  const home = await request('/v1/me/capsules', 'GET', undefined, tokens.friend);
  assert.equal(home.data.items[0].state, 'OPENED');
  assert.ok(!JSON.stringify(home.data).includes('openid'));
});

test('cancellation, invalid links, report and auth boundaries', async () => {
  const created = await request('/v1/capsules', 'POST', createBody('cancel-me-request-12345'), tokens.creator);
  const id = created.data.id;
  assert.equal((await request(`/v1/capsules/${id}`, 'DELETE', {}, tokens.friend)).status, 403);
  assert.equal((await request(`/v1/capsules/${id}/reports`, 'POST', {}, tokens.visitor)).status, 200);
  assert.equal((await request(`/v1/capsules/${id}`, 'DELETE', {}, tokens.creator)).data.state, 'INVALID');
  assert.equal((await request(`/v1/capsules/${id}`, 'GET', undefined, tokens.visitor)).data.state, 'INVALID');
  assert.equal((await request('/v1/me/capsules')).status, 401);
  assert.equal((await request('/v1/capsules/not-a-uuid', 'GET', undefined, tokens.visitor)).data.state, 'INVALID');
});

test('creator can cancel before the deadline but not at or after it', async () => {
  const start = new Date(clock);
  const deadline = new Date(start.getTime() + 3600000);
  const ids = [];
  for (const suffix of ['before', 'exact', 'after']) {
    const created = await request('/v1/capsules', 'POST', { ...createBody(`cancel-boundary-${suffix}-12345`), opens_at: deadline.toISOString() }, tokens.creator);
    assert.equal(created.status, 201);
    ids.push(created.data.id);
  }
  clock = new Date(deadline.getTime() - 1);
  assert.equal((await request(`/v1/capsules/${ids[0]}`, 'DELETE', {}, tokens.creator)).status, 200);
  clock = deadline;
  const exact = await request(`/v1/capsules/${ids[1]}`, 'DELETE', {}, tokens.creator);
  assert.equal(exact.status, 409); assert.equal(exact.data.error.code, 'CANNOT_CANCEL');
  clock = new Date(deadline.getTime() + 1);
  const after = await request(`/v1/capsules/${ids[2]}`, 'DELETE', {}, tokens.creator);
  assert.equal(after.status, 409); assert.equal(after.data.error.code, 'CANNOT_CANCEL');
  assert.equal((await request(`/v1/capsules/${ids[2]}`, 'GET', undefined, tokens.creator)).data.state, 'DUE');
  clock = start;
});

test('cancel and join racing cannot leave a cancelled capsule with a second participant', async () => {
  const created = await request('/v1/capsules', 'POST', createBody('cancel-race-request-12345'), tokens.creator);
  const id = created.data.id;
  const [cancel, join] = await Promise.all([
    request(`/v1/capsules/${id}`, 'DELETE', {}, tokens.creator),
    request(`/v1/capsules/${id}/stances`, 'POST', { stance: 'agree', alias: '朋友' }, tokens.friend)
  ]);
  const row = (await pool.query(`SELECT c.status,(SELECT count(*)::int FROM stances WHERE capsule_id=c.id) count FROM capsules c WHERE id=$1`, [id])).rows[0];
  assert.ok((row.status === 'cancelled' && row.count === 1 && cancel.status === 200 && join.status === 404) ||
    (row.status === 'sealed' && row.count === 2 && cancel.status === 409 && join.status === 200));
});

test('home prioritizes due records and analytics drops free text', async () => {
  const due = await request('/v1/capsules', 'POST', { ...createBody('due-sort-request-12345'), opens_at: new Date(clock.getTime()+600000).toISOString() }, tokens.creator);
  await request('/v1/capsules', 'POST', createBody('active-sort-request-12345'), tokens.creator);
  clock = new Date(clock.getTime()+600000);
  const home = await request('/v1/me/capsules', 'GET', undefined, tokens.creator);
  assert.equal(home.data.items[0].id, due.data.id);
  assert.equal(home.data.items[0].state, 'DUE');
  const filtered = await request('/v1/me/capsules?state=DUE', 'GET', undefined, tokens.creator);
  assert.ok(filtered.data.items.every(item => item.state === 'DUE'));
  const event = await request('/v1/events', 'POST', { name: 'home_view', capsule_id: due.data.id, statement: '敏感原话', alias: '秘密称呼', entry_source: 'home' }, tokens.creator);
  assert.equal(event.status, 200);
  const props = (await pool.query("SELECT properties FROM analytics_events WHERE name='home_view' ORDER BY id DESC LIMIT 1")).rows[0].properties;
  assert.deepEqual(props, { entry_source: 'home' });
});

test('reminder API lifecycle, linkage, due boundary and list summary', async () => {
  const oldClock = clock;
  const oldTemplate = process.env.WECHAT_REMINDER_TEMPLATE_ID;
  process.env.WECHAT_REMINDER_TEMPLATE_ID = 'test-template';

  try {
    const body = createBody('reminder-api-' + Date.now());
    const created = await request('/v1/capsules', 'POST', body, tokens.creator);
    assert.equal(created.status, 201);
    const id = created.data.id;
    const reminder = {
      template_id: 'test-template',
      timezone_offset_minutes: 480
    };

    let r = await request('/v1/capsules/' + id + '/reminder', 'POST', reminder, tokens.visitor);
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'REMINDER_NOT_ELIGIBLE');

    r = await request('/v1/capsules/' + id + '/reminder', 'POST', {
      ...reminder, template_id: 'wrong-template'
    }, tokens.creator);
    assert.equal(r.status, 400);

    r = await request('/v1/capsules/' + id + '/reminder', 'POST', {
      ...reminder, timezone_offset_minutes: 841
    }, tokens.creator);
    assert.equal(r.status, 400);

    r = await request('/v1/capsules/' + id + '/reminder', 'POST', reminder, tokens.creator);
    assert.equal(r.status, 200);
    assert.equal(r.data.state, 'armed');

    r = await request('/v1/capsules/' + id + '/reminder', 'POST', reminder, tokens.creator);
    assert.equal(r.status, 200);
    assert.equal(r.data.state, 'armed');

    r = await request('/v1/capsules/' + id, 'GET', undefined, tokens.creator);
    assert.equal(r.status, 200);
    assert.equal(r.data.viewer.reminder.state, 'armed');
    assert.equal(r.data.viewer.reminder.eligible, true);
    assert.equal(JSON.stringify(r.data).includes('openid'), false);

    r = await request('/v1/me/capsules?state=ALL', 'GET', undefined, tokens.creator);
    assert.equal(r.status, 200);
    assert.ok(r.data.summary);
    assert.equal(typeof r.data.summary.due_count, 'number');
    assert.equal(typeof r.data.summary.upcoming_24h_count, 'number');
    assert.ok(r.data.summary.upcoming_24h_count >= 1);
    assert.equal(JSON.stringify(r.data).includes('openid'), false);

    r = await request('/v1/capsules/' + id + '/reminder', 'DELETE', undefined, tokens.creator);
    assert.equal(r.status, 200);
    assert.equal(r.data.state, 'none');

    r = await request('/v1/capsules/' + id + '/reminder', 'DELETE', undefined, tokens.creator);
    assert.equal(r.status, 200);
    assert.equal(r.data.state, 'none');

    r = await request('/v1/capsules/' + id + '/reminder', 'POST', reminder, tokens.creator);
    assert.equal(r.status, 200);
    assert.equal(r.data.state, 'armed');

    r = await request('/v1/capsules/' + id, 'DELETE', undefined, tokens.creator);
    assert.ok(r.status === 200 || r.status === 204);
    const { rows } = await pool.query(
      'SELECT status FROM capsule_reminders WHERE capsule_id=$1', [id]
    );
    assert.equal(rows[0].status, 'cancelled');

    const dueBody = createBody('reminder-due-' + Date.now());
    const dueCreated = await request('/v1/capsules', 'POST', dueBody, tokens.creator);
    assert.equal(dueCreated.status, 201);
    clock = new Date(dueBody.opens_at);

    r = await request(
      '/v1/capsules/' + dueCreated.data.id + '/reminder',
      'POST', reminder, tokens.creator
    );
    assert.equal(r.status, 409);
  } finally {
    clock = oldClock;
    if (oldTemplate === undefined) delete process.env.WECHAT_REMINDER_TEMPLATE_ID;
    else process.env.WECHAT_REMINDER_TEMPLATE_ID = oldTemplate;
  }
});

test('reminder worker send, retry, terminal failure', async () => {
  const { createReminderWorker } = require('../server/reminders/worker');
  const oldClock = clock;
  const oldTemplate = process.env.WECHAT_REMINDER_TEMPLATE_ID;
  process.env.WECHAT_REMINDER_TEMPLATE_ID = 'test-template';

  async function armed(tag) {
    const body = createBody('worker-' + tag + '-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    const created = await request('/v1/capsules', 'POST', body, tokens.creator);
    assert.equal(created.status, 201);
    const id = created.data.id;
    const arm = await request('/v1/capsules/' + id + '/reminder', 'POST', {
      template_id: 'test-template',
      timezone_offset_minutes: 480
    }, tokens.creator);
    assert.equal(arm.status, 200);
    return { id, opensAt: new Date(body.opens_at) };
  }

  try {
    const first = await armed('once');
    let sends = 0;
    const worker = createReminderWorker(pool, {
      now: () => clock,
      send: async () => { sends++; }
    });

    clock = new Date(first.opensAt.getTime() - 1);
    assert.equal(await worker.tick(), null);
    assert.equal(sends, 0);

    clock = new Date(first.opensAt);
    await Promise.all([worker.tick(), worker.tick()]);
    assert.equal(sends, 1);

    let r = await pool.query(
      'SELECT status, attempt_count FROM capsule_reminders WHERE capsule_id=$1',
      [first.id]
    );
    assert.equal(r.rows[0].status, 'sent');
    assert.equal(r.rows[0].attempt_count, 1);

    const rearm = await request('/v1/capsules/' + first.id + '/reminder', 'POST', {
      template_id: 'test-template',
      timezone_offset_minutes: 480
    }, tokens.creator);
    assert.equal(rearm.status, 409);

    const second = await armed('retry');
    let attempts = 0;
    const retryWorker = createReminderWorker(pool, {
      now: () => clock,
      send: async () => {
        attempts++;
        const e = new Error(attempts === 1 ? 'temporary' : 'terminal');
        e.code = attempts === 1 ? 'TEMP' : 'FINAL';
        e.terminal = attempts > 1;
        throw e;
      }
    });

    clock = new Date(second.opensAt);
    await retryWorker.tick();
    assert.equal(attempts, 1);

    r = await pool.query(
      'SELECT status,attempt_count,next_attempt_at FROM capsule_reminders WHERE capsule_id=$1',
      [second.id]
    );
    assert.equal(r.rows[0].status, 'pending');
    assert.equal(r.rows[0].attempt_count, 1);
    assert.ok(new Date(r.rows[0].next_attempt_at) > clock);

    assert.equal(await retryWorker.tick(), null);
    assert.equal(attempts, 1);

    clock = new Date(r.rows[0].next_attempt_at);
    await retryWorker.tick();
    assert.equal(attempts, 2);

    r = await pool.query(
      'SELECT status,attempt_count FROM capsule_reminders WHERE capsule_id=$1',
      [second.id]
    );
    assert.equal(r.rows[0].status, 'failed');
    assert.equal(r.rows[0].attempt_count, 2);
  } finally {
    clock = oldClock;
    if (oldTemplate === undefined) delete process.env.WECHAT_REMINDER_TEMPLATE_ID;
    else process.env.WECHAT_REMINDER_TEMPLATE_ID = oldTemplate;
  }
});

const { randomUUID } = require('crypto');
const { createReminderWorker } = require('../server/reminders/worker');

test('reminder worker lease recovery, expiry, and stale fencing', async () => {
  const oldClock = clock;
  const oldTemplate = process.env.WECHAT_REMINDER_TEMPLATE_ID;
  process.env.WECHAT_REMINDER_TEMPLATE_ID = 'test-template';

  const createArmed = async tag => {
    const rid = tag + '-' + randomUUID();
    const created = await request('/v1/capsules', 'POST', createBody(rid), tokens.creator);
    assert.equal(created.status, 201);
    const id = created.data.id;
    const opensAt = new Date(created.data.opens_at);
    const armed = await request('/v1/capsules/' + id + '/reminder', 'POST', {
      template_id: 'test-template',
      timezone_offset_minutes: 480
    }, tokens.creator);
    assert.ok(armed.status === 200 || armed.status === 201);
    return { id, opensAt };
  };

  try {
    const recovered = await createArmed('lease-recovery');
    clock = new Date(recovered.opensAt);
    await pool.query(
      `UPDATE capsule_reminders
       SET status='sending', lease_token=$2, lease_until=$3, attempt_count=1
       WHERE capsule_id=$1`,
      [recovered.id, randomUUID(), new Date(clock.getTime() - 1)]
    );
    let sends = 0;
    const worker = createReminderWorker(pool, {
      now: () => clock,
      send: async () => { sends++; }
    });
    await worker.tick();
    assert.equal(sends, 1);
    let row = (await pool.query(
      'SELECT status,attempt_count FROM capsule_reminders WHERE capsule_id=$1',
      [recovered.id]
    )).rows[0];
    assert.equal(row.status, 'sent');
    assert.equal(row.attempt_count, 2);

    const expired = await createArmed('exact-expiry');
    clock = new Date(expired.opensAt.getTime() + 24 * 60 * 60 * 1000);
    sends = 0;
    await createReminderWorker(pool, {
      now: () => clock,
      send: async () => { sends++; }
    }).tick();
    assert.equal(sends, 0);
    row = (await pool.query(
      'SELECT status FROM capsule_reminders WHERE capsule_id=$1',
      [expired.id]
    )).rows[0];
    assert.equal(row.status, 'expired');

    const stale = await createArmed('stale-fence');
    clock = new Date(stale.opensAt);
    let releaseSend;
    let sendStarted;
    const started = new Promise(resolve => { sendStarted = resolve; });
    const held = new Promise(resolve => { releaseSend = resolve; });
    const staleWorker = createReminderWorker(pool, {
      now: () => clock,
      send: async () => { sendStarted(); await held; }
    });
    const pendingTick = staleWorker.tick();
    await started;
    const newerLease = randomUUID();
    await pool.query(
      `UPDATE capsule_reminders SET lease_token=$2, lease_until=$3
       WHERE capsule_id=$1 AND status='sending'`,
      [stale.id, newerLease, new Date(clock.getTime() + 120000)]
    );
    releaseSend();
    const result = await pendingTick;
    assert.equal(typeof result === 'string' ? result : result.result, 'stale');
    row = (await pool.query(
      'SELECT status,lease_token FROM capsule_reminders WHERE capsule_id=$1',
      [stale.id]
    )).rows[0];
    assert.equal(row.status, 'sending');
    assert.equal(row.lease_token, newerLease);
  } finally {
    clock = oldClock;
    if (oldTemplate === undefined) delete process.env.WECHAT_REMINDER_TEMPLATE_ID;
    else process.env.WECHAT_REMINDER_TEMPLATE_ID = oldTemplate;
  }
});

test('reminder deadline idempotency and permission event privacy', async () => {
  const oldClock = clock, oldTemplate = process.env.WECHAT_REMINDER_TEMPLATE_ID;
  try {
    process.env.WECHAT_REMINDER_TEMPLATE_ID = 'test-template';
    const body = createBody('reminder-deadline-' + Date.now());
    const opensAt = new Date(clock.getTime() + 60 * 60 * 1000);
    body.opens_at = opensAt.toISOString();
    const created = await request('/v1/capsules', 'POST', body, tokens.creator);
    const id = created.data.id;
    clock = new Date(opensAt.getTime() - 1);
    let armed = await request(`/v1/capsules/${id}/reminder`, 'POST',
      {template_id:'test-template', timezone_offset_minutes:480}, tokens.creator);
    assert.equal(armed.status, 200);
    clock = new Date(opensAt);
    armed = await request(`/v1/capsules/${id}/reminder`, 'POST',
      {template_id:'test-template', timezone_offset_minutes:480}, tokens.creator);
    assert.equal(armed.status, 200);
    assert.equal(armed.data.state, 'armed');
    const reminders = await pool.query(
      'SELECT count(*)::int n FROM capsule_reminders WHERE capsule_id=$1', [id]);
    assert.equal(reminders.rows[0].n, 1);
    await request('/v1/events', 'POST', {name:'reminder_permission_result',
      permission_result:'秘密别名', reminder_state:'我的观点'}, tokens.creator);
    const ev = await pool.query("SELECT properties FROM analytics_events WHERE name='reminder_permission_result' ORDER BY id DESC LIMIT 1");
    assert.equal(ev.rows[0].properties.permission_result, undefined);
    assert.equal(ev.rows[0].properties.reminder_state, undefined);
  } finally {
    clock = oldClock;
    if (oldTemplate === undefined) delete process.env.WECHAT_REMINDER_TEMPLATE_ID;
    else process.env.WECHAT_REMINDER_TEMPLATE_ID = oldTemplate;
  }
});

test('worker skips send when reminder is cancelled after claim commit', async () => {
  const savedClock = clock, savedTemplate = process.env.WECHAT_REMINDER_TEMPLATE_ID;
  let releaseCommit, markCommitted, tickPromise;
  const gate = new Promise(resolve => { releaseCommit = resolve; });
  const committed = new Promise(resolve => { markCommitted = resolve; });
  let interceptCommit = true, sends = 0;
  try {
    process.env.WECHAT_REMINDER_TEMPLATE_ID = 'test-template';
    const opensAt = new Date(clock.getTime() + 600000);
    const created = await request('/v1/capsules', 'POST', {
      ...createBody('worker-cancel-gap-' + Date.now()), opens_at: opensAt.toISOString()
    }, tokens.creator);
    assert.equal(created.status, 201);
    const id = created.data.id;
    assert.equal((await request(`/v1/capsules/${id}/reminder`, 'POST', {
      template_id: 'test-template', timezone_offset_minutes: 480
    }, tokens.creator)).status, 200);
    const workerPool = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, { get(target, prop) {
          if (prop === 'query') return async (...args) => {
            const result = await target.query(...args);
            if (interceptCommit && typeof args[0] === 'string' && args[0].trim().toUpperCase() === 'COMMIT') {
              interceptCommit = false;
              markCommitted();
              await gate;
            }
            return result;
          };
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      }
    };
    clock = opensAt;
    tickPromise = createReminderWorker(workerPool, { now: () => clock, send: async () => { sends++; } }).tick();
    await committed;
    assert.equal((await request(`/v1/capsules/${id}/reminder`, 'DELETE', undefined, tokens.creator)).status, 200);
    releaseCommit();
    assert.equal(await tickPromise, 'stale');
    assert.equal(sends, 0);
    assert.equal((await pool.query('SELECT status FROM capsule_reminders WHERE capsule_id=$1', [id])).rows[0].status, 'cancelled');
  } finally {
    releaseCommit();
    if (tickPromise) await tickPromise.catch(() => {});
    clock = savedClock;
    if (savedTemplate === undefined) delete process.env.WECHAT_REMINDER_TEMPLATE_ID;
    else process.env.WECHAT_REMINDER_TEMPLATE_ID = savedTemplate;
  }
});

test('reminder fails after 3 retryable send attempts', async () => {
  const oldTemplate = process.env.WECHAT_REMINDER_TEMPLATE_ID;
  const oldClock = clock;
  process.env.WECHAT_REMINDER_TEMPLATE_ID = 'test-template';
  try {
    const opensAt = new Date(clock.getTime() + 10 * 60_000);
    const created = await request('/v1/capsules', 'POST', {
      ...createBody(`retry-${process.pid}-${Date.now()}`),
      opens_at: opensAt.toISOString()
    }, tokens.creator);
    const id = created.data.id;

    await request(`/v1/capsules/${id}/reminder`, 'POST', {
      template_id: 'test-template', timezone_offset_minutes: 480
    }, tokens.creator);

    clock = opensAt;
    let sends = 0;
    const worker = createReminderWorker(pool, {
      now: () => clock,
      send: async () => {
        sends++;
        const e = new Error('offline');
        e.code = 'NETWORK';
        throw e;
      }
    });

    let row;
    for (let i = 0; i < 3; i++) {
      await worker.tick();
      ({ rows: [row] } = await pool.query(
        `SELECT status,attempt_count,next_attempt_at
         FROM capsule_reminders WHERE capsule_id=$1`, [id]));
      assert.equal(row.attempt_count, i + 1);
      if (row.status === 'pending') clock = new Date(row.next_attempt_at);
    }
    assert.equal(sends, 3);
    assert.equal(row.status, 'failed');

    await worker.tick();
    assert.equal(sends, 3);

    const { rows } = await pool.query(
      `SELECT properties->>'send_result' AS result FROM analytics_events
       WHERE capsule_id=$1 AND name='reminder_send_result' ORDER BY id`, [id]);
    assert.deepEqual(rows.map(r => r.result), ['retry', 'retry', 'terminal_fail']);
  } finally {
    clock = oldClock;
    if (oldTemplate === undefined) delete process.env.WECHAT_REMINDER_TEMPLATE_ID;
    else process.env.WECHAT_REMINDER_TEMPLATE_ID = oldTemplate;
  }
});

test('home summary counts all records, not only the first page', async () => {
  const creator = await service.authenticate(tokens.creator);
  const db = await pool.connect();
  const opensAt = new Date(clock.getTime() - 3600000);
  try {
    await db.query('BEGIN');
    for (let i = 0; i < 21; i++) {
      const capsuleId = randomUUID();
      await db.query(
        `INSERT INTO capsules
          (id,creator_user_id,creator_alias_snapshot,statement,opens_at,status,client_request_id)
         VALUES($1,$2,'AJ','分页汇总测试',$3,'sealed',$4)`,
        [capsuleId, creator.id, opensAt, `summary-${randomUUID()}`]
      );
      await db.query(
        `INSERT INTO stances(id,capsule_id,user_id,alias_snapshot,stance)
         VALUES($1,$2,$3,'AJ',true)`,
        [randomUUID(), capsuleId, creator.id]
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }

  const all = await request('/v1/me/capsules?state=ALL', 'GET', undefined, tokens.creator);
  assert.equal(all.status, 200);
  assert.equal(all.data.items.length, 20);
  assert.ok(all.data.summary.due_count >= 21);

  const opened = await request('/v1/me/capsules?state=OPENED', 'GET', undefined, tokens.creator);
  assert.equal(opened.status, 200);
  assert.equal(opened.data.summary.due_count, all.data.summary.due_count);
  assert.ok(opened.data.items.every(item => item.state === 'OPENED'));
});
