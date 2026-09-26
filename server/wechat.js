const { ApiError } = require('./service');

function createWechat({ appId = process.env.WECHAT_APP_ID, secret = process.env.WECHAT_APP_SECRET, fetcher = fetch } = {}) {
  let access = null;
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
    try {
      const data = await get('https://api.weixin.qq.com/cgi-bin/token', {
        grant_type: 'client_credential', appid: appId, secret
      });
      if (!data.access_token) throw new Error(`WeChat code ${data.errcode}`);
      access = { value: data.access_token, expires: Date.now() + Math.max(60, data.expires_in - 300) * 1000 };
      return access.value;
    } catch { throw new ApiError(503, 'CONTENT_CHECK_UNAVAILABLE', '内容暂时无法检查，请稍后重试。'); }
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
  return { exchangeCode, checkContent };
}
module.exports = { createWechat };
