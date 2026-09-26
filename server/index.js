const http = require('node:http');
const { Pool } = require('pg');
const { createService, ApiError } = require('./service');
const { createWechat } = require('./wechat');

function createHandler(service, exchangeCode) {
  return async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/health' && req.method === 'GET') return send(200, { ok: true });
      let body = {};
      if (['POST', 'DELETE'].includes(req.method)) {
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 8192) throw new ApiError(413, 'TOO_LARGE', '请求内容过长。');
        }
        if (text) {
          try { body = JSON.parse(text); } catch { throw new ApiError(400, 'INVALID_JSON', '请求格式错误。'); }
          if (!body || Array.isArray(body) || typeof body !== 'object') throw new ApiError(400, 'INVALID_JSON', '请求格式错误。');
        }
      }
      if (url.pathname === '/v1/auth/wechat' && req.method === 'POST') return send(200, await service.login(await exchangeCode(body.code)));
      const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization || '');
      const user = await service.authenticate(bearer?.[1]);
      if (url.pathname === '/v1/capsules' && req.method === 'POST') return send(201, await service.create(user, body));
      if (url.pathname === '/v1/me/capsules' && req.method === 'GET') return send(200, await service.list(user, Object.fromEntries(url.searchParams)));
      if (url.pathname === '/v1/events' && req.method === 'POST') return send(200, await service.event(user, body));
      const match = /^\/v1\/capsules\/([^/]+)(?:\/(stances|open|reports))?$/.exec(url.pathname);
      if (!match) throw new ApiError(404, 'NOT_FOUND', '接口不存在。');
      const [, id, action] = match;
      if (!action && req.method === 'GET') return send(200, await service.detail(id, user));
      if (!action && req.method === 'DELETE') return send(200, await service.cancel(id, user));
      if (action === 'stances' && req.method === 'POST') return send(200, await service.stance(id, user, body));
      if (action === 'open' && req.method === 'POST') return send(200, await service.open(id, user));
      if (action === 'reports' && req.method === 'POST') return send(200, await service.report(id, user));
      throw new ApiError(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      if (error instanceof ApiError) return send(error.status, { error: { code: error.code, message: error.message } });
      console.error('request failed', error.code || error.name);
      return send(500, { error: { code: 'INTERNAL', message: '服务暂时不可用，请稍后重试。' } });
    }
  };
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const wechat = createWechat();
  const service = createService(pool, { checkContent: wechat.checkContent });
  http.createServer(createHandler(service, wechat.exchangeCode)).listen(Number(process.env.PORT || 3000), () => console.log('API listening'));
}
module.exports = { createHandler };
