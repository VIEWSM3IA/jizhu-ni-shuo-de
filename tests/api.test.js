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
