const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWechat } = require('../server/wechat');

test('WeChat login and content check fail closed', async () => {
  let suggestion = 'pass';
  const fetcher = async url => ({ ok: true, json: async () => {
    if (url.includes('jscode2session')) return { openid: 'openid-123' };
    if (url.includes('cgi-bin/token')) return { access_token: 'token', expires_in: 7200 };
    return { errcode: 0, result: { suggest: suggestion } };
  } });
  const wx = createWechat({ appId: 'test', secret: 'test', fetcher });
  assert.equal(await wx.exchangeCode('valid-code'), 'openid-123');
  await wx.checkContent(['正常内容'], 'openid-123');
  suggestion = 'risky';
  await assert.rejects(wx.checkContent(['违规内容'], 'openid-123'), { code: 'CONTENT_REJECTED' });
  suggestion = undefined;
  await assert.rejects(wx.checkContent(['检查失败'], 'openid-123'), { code: 'CONTENT_REJECTED' });
  const unavailable = createWechat({ appId: 'test', secret: 'test', fetcher: async () => { throw new Error('offline'); } });
  await assert.rejects(unavailable.checkContent(['内容'], 'openid-123'), { code: 'CONTENT_CHECK_UNAVAILABLE' });
});

test('WeChat reminder send payload, token reuse/refresh and terminal error', async () => {
  const keys = [
    'WECHAT_REMINDER_TEMPLATE_ID',
    'WECHAT_REMINDER_TEMPLATE_FIELDS_JSON',
    'WECHAT_MINIPROGRAM_STATE'
  ];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.WECHAT_REMINDER_TEMPLATE_ID = 'template-test';
  process.env.WECHAT_REMINDER_TEMPLATE_FIELDS_JSON =
    '{"thing1":"title","time2":"local_time","thing3":"note"}';
  process.env.WECHAT_MINIPROGRAM_STATE = 'trial';

  try {
    let tokenCalls = 0;
    const sends = [];
    let results = [];

    const fetcher = async (url, options = {}) => {
      if (url.includes('/cgi-bin/token')) {
        tokenCalls++;
        return {
          ok: true,
          json: async () => ({ access_token: `t${tokenCalls}`, expires_in: 7200 })
        };
      }
      if (url.includes('/cgi-bin/message/subscribe/send')) {
        sends.push({ url, body: JSON.parse(options.body) });
        const errcode = results.length ? results.shift() : 0;
        return { ok: true, json: async () => ({ errcode, errmsg: errcode ? 'provider error' : 'ok' }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const wx = createWechat({
      appId: 'app-test',
      secret: 'app-secret',
      fetcher
    });
    const input = {
      openid: 'openid-secret',
      templateId: 'template-test',
      capsuleId: '123e4567-e89b-42d3-a456-426614174000',
      opensAt: '2026-10-01T16:05:00.000Z',
      timezoneOffsetMinutes: 480,
      statement: 'statement-secret',
      alias: 'alias-secret',
      stance: 'stance-secret'
    };

    await wx.sendReminder(input);
    await wx.sendReminder(input);
    assert.equal(tokenCalls, 1);
    assert.equal(sends.length, 2);

    const body = sends[0].body;
    assert.equal(body.touser, 'openid-secret');
    assert.equal(body.template_id, 'template-test');
    assert.equal(body.miniprogram_state, 'trial');
    assert.match(body.page, /src=reminder/);
    assert.deepEqual(Object.keys(body.data).sort(), ['thing1', 'thing3', 'time2']);
    assert.equal(body.data.thing1.value, '该开封了');
    assert.equal(body.data.time2.value, '2026-10-02 00:05');
    assert.equal(body.data.thing3.value, '回来看看大家当时怎么说');

    const json = JSON.stringify(body);
    for (const forbidden of ['statement', 'alias', 'stance',
      'statement-secret', 'alias-secret', 'stance-secret', 'app-secret', '"t1"']) {
      assert.equal(json.includes(forbidden), false);
    }
    const withoutTouser = { ...body };
    delete withoutTouser.touser;
    assert.equal(JSON.stringify(withoutTouser).includes('openid-secret'), false);

    results = [40001, 0];
    const beforeRefresh = sends.length;
    await wx.sendReminder(input);
    assert.equal(tokenCalls, 2);
    assert.equal(sends.length, beforeRefresh + 2);
    assert.match(sends.at(-2).url, /access_token=t1/);
    assert.match(sends.at(-1).url, /access_token=t2/);

    results = [43101];
    await assert.rejects(
      wx.sendReminder(input),
      error => error && error.terminal === true
    );
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});

test('sendReminder shares token refresh and rejects bad config terminally', async () => {
  const prev = {
    template: process.env.WECHAT_REMINDER_TEMPLATE_ID,
    fields: process.env.WECHAT_REMINDER_TEMPLATE_FIELDS_JSON,
    state: process.env.WECHAT_MINIPROGRAM_STATE,
  };
  process.env.WECHAT_REMINDER_TEMPLATE_ID = 'template-test';
  process.env.WECHAT_REMINDER_TEMPLATE_FIELDS_JSON =
    JSON.stringify({ thing1: 'title', time2: 'local_time', thing3: 'note' });
  process.env.WECHAT_MINIPROGRAM_STATE = 'trial';

  let tokenCalls = 0, sendCalls = 0;
  const fetcher = async (url) => {
    if (url.includes('/cgi-bin/token')) {
      tokenCalls++;
      return { ok: true, json: async () => ({ access_token: 't1', expires_in: 7200 }) };
    }
    if (url.includes('/message/subscribe/send')) {
      sendCalls++;
      return { ok: true, json: async () => ({ errcode: 0, errmsg: 'ok' }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const input = {
    openid: 'oid',
    templateId: 'template-test',
    capsuleId: '123e4567-e89b-42d3-a456-426614174000',
    opensAt: '2026-10-01T02:00:00.000Z',
    timezoneOffsetMinutes: 480,
  };

  try {
    const wx = createWechat({ appId: 'app', secret: 'secret', fetcher });
    await Promise.all(Array.from({ length: 10 }, () => wx.sendReminder(input)));
    assert.equal(tokenCalls, 1);
    assert.equal(sendCalls, 10);

    const before = tokenCalls + sendCalls;
    process.env.WECHAT_REMINDER_TEMPLATE_FIELDS_JSON = JSON.stringify({ time1: 'title' });
    await assert.rejects(wx.sendReminder(input), (err) => {
      assert.equal(err.code, 'WECHAT_REMINDER_BAD_CONFIG');
      assert.equal(err.terminal, true);
      return true;
    });
    assert.equal(tokenCalls + sendCalls, before);

    process.env.WECHAT_REMINDER_TEMPLATE_FIELDS_JSON =
      JSON.stringify({ thing1: 'title', time2: 'local_time', thing3: 'note' });
    const unconfigured = createWechat({ appId: '', secret: '', fetcher });
    await assert.rejects(unconfigured.sendReminder(input), (err) => {
      assert.equal(err.code, 'WECHAT_REMINDER_BAD_CONFIG');
      assert.equal(err.terminal, true);
      return true;
    });
  } finally {
    for (const [key, value] of Object.entries({
      WECHAT_REMINDER_TEMPLATE_ID: prev.template,
      WECHAT_REMINDER_TEMPLATE_FIELDS_JSON: prev.fields,
      WECHAT_MINIPROGRAM_STATE: prev.state,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
