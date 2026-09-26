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
