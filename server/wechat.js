const { ApiError } = require('./service');

function createWechat({ appId = process.env.WECHAT_APP_ID, secret = process.env.WECHAT_APP_SECRET, fetcher = fetch } = {}) {
  let access = null;
  let pendingToken = null;
  async function get(url, params) {
    const response = await fetcher(`${url}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`WeChat HTTP ${response.status}`);
    return response.json();
  }
  async function exchangeCode(code) {
    if (!appId || !secret) throw new ApiError(503, 'WECHAT_UNCONFIGURED', '微信服务尚未配置。');
    if (typeof code !== 'string' || !code || code.length > 256) throw new ApiError(400, 'INVALID_CODE', '登录凭据无效。');
    try {
      const data = await get('https://api.weixin.qq.com/sns/jscode2session', {
        appid: appId, secret, js_code: code, grant_type: 'authorization_code'
      });
      if (!data.openid || data.errcode) throw new Error(`WeChat code ${data.errcode}`);
      return data.openid;
    } catch { throw new ApiError(502, 'WECHAT_LOGIN_FAILED', '微信登录失败，请重试。'); }
  }
  async function token() {
    if (!appId || !secret) throw new ApiError(503, 'WECHAT_UNCONFIGURED', '微信服务尚未配置。');
    if (access && access.expires > Date.now()) return access.value;
    if (!pendingToken) pendingToken = (async () => {
      try {
        const data = await get('https://api.weixin.qq.com/cgi-bin/token', {
          grant_type: 'client_credential', appid: appId, secret
        });
        const expiresIn = Number(data.expires_in);
        if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Invalid WeChat token response');
        access = { value: data.access_token, expires: Date.now() + Math.max(1, expiresIn - 300) * 1000 };
        return access.value;
      } catch { throw new ApiError(503, 'CONTENT_CHECK_UNAVAILABLE', '内容暂时无法检查，请稍后重试。'); }
    })();
    try { return await pendingToken; }
    finally { pendingToken = null; }
  }
  async function checkContent(values, openid) {
    for (const content of values) {
      try {
        const response = await fetcher(`https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${encodeURIComponent(await token())}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, openid, scene: 2, version: 2 }), signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) throw new Error(`WeChat HTTP ${response.status}`);
        const data = await response.json();
        if (data.errcode !== 0) throw new Error(`WeChat code ${data.errcode}`);
        if (data.result?.suggest !== 'pass') throw new ApiError(422, 'CONTENT_REJECTED', '这段内容暂时不能发布，请修改后重试。');
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, 'CONTENT_CHECK_UNAVAILABLE', '内容暂时无法检查，请稍后重试。');
      }
    }
  }
  function reminderError(code, terminal = false) {
    const error = new Error('WeChat reminder delivery failed');
    error.code = code;
    error.terminal = terminal;
    return error;
  }
  function reminderConfig(templateId) {
    const configured = process.env.WECHAT_REMINDER_TEMPLATE_ID;
    const state = process.env.WECHAT_MINIPROGRAM_STATE || 'formal';
    let fields;
    try { fields = JSON.parse(process.env.WECHAT_REMINDER_TEMPLATE_FIELDS_JSON || ''); }
    catch { throw reminderError('WECHAT_REMINDER_BAD_CONFIG', true); }
    if (!configured || templateId !== configured || !['trial', 'formal'].includes(state) ||
        !fields || Array.isArray(fields) || typeof fields !== 'object') throw reminderError('WECHAT_REMINDER_BAD_CONFIG', true);
    const entries = Object.entries(fields), names = entries.map(([, name]) => name);
    const allowed = new Set(['title', 'local_time', 'note']);
    if (entries.length < 1 || entries.length > 3 || entries.some(([key, name]) =>
      !allowed.has(name) || !(name === 'local_time' ? /^(time|date)[1-9][0-9]*$/ : /^(thing|character_string)[1-9][0-9]*$/).test(key)) ||
      new Set(names).size !== names.length) throw reminderError('WECHAT_REMINDER_BAD_CONFIG', true);
    return { fields, state };
  }
  function localTime(value, offset) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || !Number.isInteger(offset) || offset < -720 || offset > 840) throw reminderError('WECHAT_REMINDER_BAD_INPUT', true);
    const d = new Date(date.getTime() + offset * 60000), pad = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  async function sendReminder({ openid, templateId, capsuleId, opensAt, timezoneOffsetMinutes }) {
    const { fields, state } = reminderConfig(templateId);
    if (typeof openid !== 'string' || !openid ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(capsuleId)) throw reminderError('WECHAT_REMINDER_BAD_INPUT', true);
    const values = { title: '该开封了', note: '回来看看大家当时怎么说' };
    if (Object.values(fields).includes('local_time')) values.local_time = localTime(opensAt, timezoneOffsetMinutes);
    const data = {};
    for (const [key, name] of Object.entries(fields)) data[key] = { value: values[name] };
    const body = { touser: openid, template_id: templateId,
      page: 'pages/capsule/detail?id=' + capsuleId + '&src=reminder',
      miniprogram_state: state, lang: 'zh_CN', data };
    const terminalCodes = { 40003: 'WECHAT_REMINDER_INVALID_OPENID', 40037: 'WECHAT_REMINDER_INVALID_TEMPLATE',
      43101: 'WECHAT_REMINDER_NOT_SUBSCRIBED', 47003: 'WECHAT_REMINDER_BAD_DATA', 41030: 'WECHAT_REMINDER_BAD_PAGE' };
    for (let attempt = 0; attempt < 2; attempt++) {
      let accessToken;
      try { accessToken = await token(); }
      catch (error) { throw reminderError(error?.code === 'WECHAT_UNCONFIGURED' ? 'WECHAT_REMINDER_BAD_CONFIG' : 'WECHAT_REMINDER_TOKEN_UNAVAILABLE', error?.code === 'WECHAT_UNCONFIGURED'); }
      try {
        const response = await fetcher('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + encodeURIComponent(accessToken), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000)
        });
        if (response.status >= 500) throw reminderError('WECHAT_REMINDER_UPSTREAM');
        if (!response.ok) throw reminderError('WECHAT_REMINDER_HTTP_ERROR');
        const result = await response.json();
        if (result.errcode === 0) return;
        if ((result.errcode === 40001 || result.errcode === 42001) && attempt === 0) { access = null; continue; }
        if (terminalCodes[result.errcode]) throw reminderError(terminalCodes[result.errcode], true);
        throw reminderError('WECHAT_REMINDER_PROVIDER_ERROR');
      } catch (error) {
        if (error?.code?.startsWith('WECHAT_REMINDER_')) throw error;
        throw reminderError('WECHAT_REMINDER_NETWORK');
      }
    }
    throw reminderError('WECHAT_REMINDER_AUTH_ERROR');
  }
  return { exchangeCode, checkContent, sendReminder };
}
module.exports = { createWechat };
