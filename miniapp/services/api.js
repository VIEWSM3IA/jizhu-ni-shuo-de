const { apiBaseUrl } = require('../config');
const app = () => getApp();

function raw(path, method, data, token) {
  return new Promise((resolve, reject) => wx.request({
    url: `${apiBaseUrl}${path}`, method, data, timeout: 10000,
    header: token ? { Authorization: `Bearer ${token}` } : {},
    success: response => {
      if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data);
      else {
        const error = new Error(response.data?.error?.message || '请求失败，请重试。');
        error.code = response.data?.error?.code;
        error.status = response.statusCode;
        reject(error);
      }
    }, fail: reject
  }));
}
async function request(path, method = 'GET', data) {
  if (!app().globalData.token) await app().login();
  try { return await raw(path, method, data, app().globalData.token); }
  catch (error) {
    if (error.status !== 401) throw error;
    await app().login(true);
    return raw(path, method, data, app().globalData.token);
  }
}
function track(name, fields = {}) { request('/v1/events', 'POST', { name, ...fields }).catch(() => {}); }
module.exports = { request, track };
